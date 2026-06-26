// Report orchestrator: a finished month is fetched once and stored; any team's
// report = stored completed months + the live current month. With no DATABASE_URL
// it falls back to fetching everything live.
import { graphql, type GraphQL } from './github/client';
import { lastNMonths, monthKey, type Month } from './github/months';
import {
	fetchRepoMonthRows,
	fetchMemberRepoMonthRows,
	fetchReviewRepoMonthRows
} from './github/metrics';
import { assembleMetrics, type MemberRepoMonthRow, type ReviewRepoMonthRow } from './store/assemble';
import * as store from './store';
import { hasDb } from './db';
import type { Selection, MetricsResult, RepoMonth, Repo, Member } from './github/types';

const rk = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;
const isCompleted = (m: Month, currentKey: string) => monthKey(m) !== currentKey;

export async function getReport(
	selection: Selection,
	now: Date = new Date(),
	gql: GraphQL = graphql
): Promise<MetricsResult> {
	const months = lastNMonths(selection.months, now);
	const memberMonths = lastNMonths(Math.min(selection.memberMonths, selection.months), now);
	const currentKey = monthKey({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });

	if (!hasDb()) {
		const [repoRows, memberRows, reviewRows] = await Promise.all([
			fetchRepoMonthRows(gql, selection.repos, months),
			fetchMemberRepoMonthRows(gql, selection.repos, selection.members, memberMonths),
			fetchReviewRepoMonthRows(gql, selection.repos, memberMonths)
		]);
		return assembleMetrics({ repoRows, memberRows, reviewRows }, selection.members, now.getTime());
	}

	// Repo/review and member resolution are independent; run them together so a cold
	// fetch saturates the GraphQL concurrency pool instead of draining between phases.
	const [{ repoRows, reviewRows }, memberRows] = await Promise.all([
		resolveRepoAndReview(gql, selection.repos, months, currentKey),
		resolveMembers(gql, selection.repos, selection.members, memberMonths, currentKey)
	]);
	// Reviews are member activity, so scope them to the member window — matching the
	// no-DB path (which fetches reviews for memberMonths only).
	const memberMonthKeys = new Set(memberMonths.map(monthKey));
	const scopedReviews = reviewRows.filter((r) => memberMonthKeys.has(r.month));
	return assembleMetrics({ repoRows, memberRows, reviewRows: scopedReviews }, selection.members, now.getTime());
}

// repo_month presence is the completeness marker for a (repo, month); reviews for
// the same (repo, month) are always fetched + stored alongside it.
async function resolveRepoAndReview(
	gql: GraphQL,
	repos: Repo[],
	months: Month[],
	currentKey: string
): Promise<{ repoRows: RepoMonth[]; reviewRows: ReviewRepoMonthRow[] }> {
	const current = months.filter((m) => !isCompleted(m, currentKey));
	const completed = months.filter((m) => isCompleted(m, currentKey));
	const completedKeys = completed.map(monthKey);

	const storedRepo = await store.getRepoMonths(repos, completedKeys);
	const present = new Set(storedRepo.map((r) => `${rk(r)}::${r.month}`));
	const missing = completed.filter((m) => !repos.every((r) => present.has(`${rk(r)}::${monthKey(m)}`)));

	if (missing.length) {
		const [repoRows, reviewRows] = await Promise.all([
			fetchRepoMonthRows(gql, repos, missing),
			fetchReviewRepoMonthRows(gql, repos, missing)
		]);
		await Promise.all([store.upsertRepoMonths(repoRows), store.upsertReviewRepoMonths(reviewRows)]);
	}

	// Only re-read repo_month if we just back-filled; otherwise reuse the first read.
	const [doneRepo, doneReview, curRepo, curReview] = await Promise.all([
		missing.length ? store.getRepoMonths(repos, completedKeys) : Promise.resolve(storedRepo),
		store.getReviewRepoMonths(repos, completedKeys),
		fetchRepoMonthRows(gql, repos, current),
		fetchReviewRepoMonthRows(gql, repos, current)
	]);

	return { repoRows: [...doneRepo, ...curRepo], reviewRows: [...doneReview, ...curReview] };
}

// member_repo_month presence is per (member, repo, month) — zeros are stored too,
// so a never-queried member triggers a one-time back-fill.
async function resolveMembers(
	gql: GraphQL,
	repos: Repo[],
	members: Member[],
	months: Month[],
	currentKey: string
): Promise<MemberRepoMonthRow[]> {
	if (!members.length) return [];
	const completed = months.filter((m) => isCompleted(m, currentKey));
	const completedKeys = completed.map(monthKey);
	const logins = members.map((m) => m.login);

	const stored = await store.getMemberRepoMonths(logins, repos, completedKeys);
	const present = new Set(stored.map((r) => `${r.login}::${rk(r)}::${r.month}`));
	const missing = completed.filter(
		(m) => !members.every((mem) => repos.every((r) => present.has(`${mem.login}::${rk(r)}::${monthKey(m)}`)))
	);

	if (missing.length) {
		const fetched = await fetchMemberRepoMonthRows(gql, repos, members, missing);
		await store.upsertMemberRepoMonths(fillMemberGrid(members, repos, missing, fetched));
	}

	const [done, current] = await Promise.all([
		store.getMemberRepoMonths(logins, repos, completedKeys),
		fetchMemberRepoMonthRows(gql, repos, members, months.filter((m) => !isCompleted(m, currentKey)))
	]);
	return [...done, ...current];
}

// Expand fetched (non-zero) member rows to a full grid so every (member, repo,
// month) gets a stored row — that zero row is the "already fetched" marker.
function fillMemberGrid(
	members: Member[],
	repos: Repo[],
	months: Month[],
	fetched: MemberRepoMonthRow[]
): MemberRepoMonthRow[] {
	const byKey = new Map(fetched.map((r) => [`${r.login}::${rk(r)}::${r.month}`, r]));
	const out: MemberRepoMonthRow[] = [];
	for (const mem of members) {
		for (const r of repos) {
			for (const m of months) {
				const key = `${mem.login}::${rk(r)}::${monthKey(m)}`;
				out.push(byKey.get(key) ?? { login: mem.login, owner: r.owner, repo: r.repo, month: monthKey(m), commits: 0, mergedPrs: 0, additions: 0, deletions: 0 });
			}
		}
	}
	return out;
}
