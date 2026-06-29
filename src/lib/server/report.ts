// Report orchestrator. Every (repo, month) is persisted and reused across teams.
// A month is refetched from GitHub only when its stored row is stale:
//   - completed month: stale until it has been fetched AFTER the month ended
//     (so a month first stored while in-progress gets one finalizing pull, then
//     is frozen forever).
//   - current month: stale once older than CURRENT_MONTH_TTL_MS.
// With no DATABASE_URL it falls back to fetching everything live every time.
import { env } from '$env/dynamic/private';
import { graphql, type GraphQL } from './github/client';
import { lastNMonths, monthsEndingAt, monthKey, monthEndMs, type Month } from './github/months';
import {
	fetchRepoMonthRows,
	fetchMemberRepoMonthRows,
	fetchReviewRepoMonthRows
} from './github/metrics';
import { assembleMetrics, type MemberRepoMonthRow, type ReviewRepoMonthRow } from './store/assemble';
import { excludeReleases, globalNoReleaseRepos } from './release-exclusions';
import * as store from './store';
import { hasDb } from './db';
import { getAppSettings } from './app-config';
import type { Selection, MetricsResult, RepoMonth, Repo, Member } from './github/types';

const rk = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;

// How long the in-progress month's data is trusted before a refresh. Completed
// months never expire (their freshness floor is the end of the month). A valid
// 0 means "always refetch the current month", so don't fall through on falsy-0.
const ttlEnv = Number(env.CURRENT_MONTH_TTL_MS);
const CURRENT_TTL_MS = Number.isFinite(ttlEnv) && ttlEnv >= 0 ? ttlEnv : 6 * 60 * 60 * 1000;

// A stored row for month `m` is authoritative only if it was fetched after this
// instant. Completed months: after the month ended. Current month: within TTL.
export function freshnessFloor(m: Month, currentKey: string, nowMs: number): number {
	return monthKey(m) === currentKey ? nowMs - CURRENT_TTL_MS : monthEndMs(m);
}

/** The months that must be (re)fetched from GitHub: any month where some required
 * key is missing from the store or was fetched at/before its freshness floor.
 * `requiredKeys(m)` lists every store key that must be fresh for month `m` to be
 * served from cache (one per repo, or per member×repo). */
export function monthsToFetch(
	months: Month[],
	requiredKeys: (m: Month) => string[],
	fetchedAt: Map<string, Date>,
	currentKey: string,
	nowMs: number
): Month[] {
	return months.filter((m) => {
		const floor = freshnessFloor(m, currentKey, nowMs);
		return !requiredKeys(m).every((k) => {
			const f = fetchedAt.get(k);
			return f !== undefined && f.getTime() > floor;
		});
	});
}

export async function getReport(
	selection: Selection,
	now: Date = new Date(),
	gql: GraphQL = graphql
): Promise<MetricsResult> {
	const memberCount = Math.min(selection.memberMonths, selection.months);
	// An explicit `to` ends the window at that month; otherwise it rolls with now.
	const months = selection.to
		? monthsEndingAt(selection.to, selection.months)
		: lastNMonths(selection.months, now);
	const memberMonths = selection.to
		? monthsEndingAt(selection.to, memberCount)
		: lastNMonths(memberCount, now);
	const currentKey = monthKey({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
	const nowMs = now.getTime();
	// Repos whose releases are excluded from the stats (global ignore-list + the
	// selection's own per-repo flags); applied to the rows before aggregation.
	const noReleases = globalNoReleaseRepos();

	if (!hasDb()) {
		console.warn(
			'[report] DATABASE_URL is not set: fetching everything live with no persistence. ' +
				'Set DATABASE_URL so completed months are cached and the GitHub token is not rate limited.'
		);
		const [repoRows, memberRows, reviewRows] = await Promise.all([
			fetchRepoMonthRows(gql, selection.repos, months),
			fetchMemberRepoMonthRows(gql, selection.repos, selection.members, memberMonths),
			fetchReviewRepoMonthRows(gql, selection.repos, memberMonths)
		]);
		return assembleMetrics(
			{ repoRows: excludeReleases(repoRows, selection.repos, noReleases), memberRows, reviewRows },
			selection.members,
			nowMs
		);
	}

	const [repoRes, memberRes] = await Promise.all([
		resolveRepoAndReview(gql, selection.repos, months, currentKey, nowMs),
		resolveMembers(gql, selection.repos, selection.members, memberMonths, currentKey, nowMs)
	]);
	// If a refresh failed and the store had nothing to fall back on, there's no
	// report to serve — surface the error (rate limit, etc.) instead of a blank one.
	if (!repoRes.repoRows.length && repoRes.fetchError) throw repoRes.fetchError;

	// Reviews are member activity, so scope them to the member window — matching the
	// no-DB path (which fetches reviews for memberMonths only).
	const memberMonthKeys = new Set(memberMonths.map(monthKey));
	const scopedReviews = repoRes.reviewRows.filter((r) => memberMonthKeys.has(r.month));

	console.info(
		`[report] repos=${selection.repos.length} months=${selection.months} ` +
			`repoMonthsFetched=${repoRes.fetched}/${months.length} ` +
			`memberMonthsFetched=${memberRes.fetched}/${memberMonths.length}`
	);
	return assembleMetrics(
		{
			repoRows: excludeReleases(repoRes.repoRows, selection.repos, noReleases),
			memberRows: memberRes.rows,
			reviewRows: scopedReviews
		},
		selection.members,
		nowMs
	);
}

// repo_month + review_repo_month: fetch only the stale months, persist, then read
// the full window back from the store.
async function resolveRepoAndReview(
	gql: GraphQL,
	repos: Repo[],
	months: Month[],
	currentKey: string,
	nowMs: number
): Promise<{
	repoRows: RepoMonth[];
	reviewRows: ReviewRepoMonthRow[];
	fetched: number;
	fetchError?: unknown;
}> {
	const keys = months.map(monthKey);
	// One read returns the rows and the fetched_at map that drives staleness, in
	// parallel with reviews — no separate fetched_at query.
	let [repoRead, reviewRows] = await Promise.all([
		store.getRepoMonthsWithFetchedAt(repos, keys),
		store.getReviewRepoMonths(repos, keys)
	]);
	const stale = monthsToFetch(
		months,
		(m) => repos.map((r) => `${rk(r)}::${monthKey(m)}`),
		repoRead.fetchedAt,
		currentKey,
		nowMs
	);

	let fetchError: unknown;
	if (stale.length) {
		const { bugLabels } = await getAppSettings();
		// Fetch + persist per repo so a mid-refresh failure (e.g. a rate limit) keeps
		// the repos that already completed; the next pass retries only the rest,
		// instead of an all-or-nothing batch that loses everything on one blip.
		const results = await Promise.allSettled(
			repos.map(async (repo) => {
				const [repoRows, reviewRowsNew] = await Promise.all([
					fetchRepoMonthRows(gql, [repo], stale, bugLabels),
					fetchReviewRepoMonthRows(gql, [repo], stale)
				]);
				await Promise.all([
					store.upsertRepoMonths(repoRows),
					store.upsertReviewRepoMonths(reviewRowsNew)
				]);
			})
		);
		const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
		if (failed) {
			// Some repos failed; the report still serves what persisted (stored rows).
			fetchError = failed.reason;
			console.warn(`[report] repo refresh partial, serving stored data: ${(failed.reason as Error).message}`);
		}
		// Re-read only after a refresh; the warm path uses the rows already read.
		[repoRead, reviewRows] = await Promise.all([
			store.getRepoMonthsWithFetchedAt(repos, keys),
			store.getReviewRepoMonths(repos, keys)
		]);
	}

	return { repoRows: repoRead.rows, reviewRows, fetched: stale.length, fetchError };
}

// member_repo_month: same staleness rule, per (member, repo, month). Zeros are
// stored too (fillMemberGrid) so presence + fetched_at mark a month as resolved.
async function resolveMembers(
	gql: GraphQL,
	repos: Repo[],
	members: Member[],
	months: Month[],
	currentKey: string,
	nowMs: number
): Promise<{ rows: MemberRepoMonthRow[]; fetched: number }> {
	if (!members.length) return { rows: [], fetched: 0 };
	const keys = months.map(monthKey);
	const logins = members.map((m) => m.login);
	let { rows, fetchedAt } = await store.getMemberRepoMonthsWithFetchedAt(logins, repos, keys);
	const stale = monthsToFetch(
		months,
		(m) => members.flatMap((mem) => repos.map((r) => `${mem.login}::${rk(r)}::${monthKey(m)}`)),
		fetchedAt,
		currentKey,
		nowMs
	);

	if (stale.length) {
		// Per-repo fetch + persist so a partial failure keeps the repos that finished.
		const results = await Promise.allSettled(
			repos.map(async (repo) => {
				const fetched = await fetchMemberRepoMonthRows(gql, [repo], members, stale);
				await store.upsertMemberRepoMonths(fillMemberGrid(members, [repo], stale, fetched));
			})
		);
		const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
		if (failed) {
			// Member stats are non-essential; never let a failed refresh sink the report.
			console.warn(`[report] member refresh partial, serving stored data: ${(failed.reason as Error).message}`);
		}
		// Re-read only after a refresh; the warm path uses the rows already read.
		rows = (await store.getMemberRepoMonthsWithFetchedAt(logins, repos, keys)).rows;
	}

	return { rows, fetched: stale.length };
}

// Expand fetched (non-zero) member rows to a full grid so every (member, repo,
// month) gets a stored row — that zero row + its fetched_at marks the month resolved.
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
				out.push(
					byKey.get(key) ?? {
						login: mem.login,
						owner: r.owner,
						repo: r.repo,
						month: monthKey(m),
						commits: 0,
						mergedPrs: 0,
						additions: 0,
						deletions: 0
					}
				);
			}
		}
	}
	return out;
}
