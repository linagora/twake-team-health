import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { repoMonth, memberRepoMonth, reviewRepoMonth } from '../db/schema';
import type { Repo, RepoMonth } from '../github/types';
import type { MemberRepoMonthRow, ReviewRepoMonthRow } from './assemble';

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const repoSet = (repos: Repo[]) => new Set(repos.map((r) => `${r.owner}/${r.repo}`));
// Postgres caps a statement at 65535 bind parameters; a big team's member grid
// (members x repos x months) can exceed that, so inserts are batched. Sizes leave
// headroom for each table's column count.
const chunk = <T>(xs: T[], n: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
	return out;
};
// On-conflict updates copy from the row we tried to insert ("excluded").
const sqlExcluded = (col: string) => sql.raw(`excluded.${col}`);

// --- repo_month ---
export async function getRepoMonths(repos: Repo[], months: string[]): Promise<RepoMonth[]> {
	if (!repos.length || !months.length) return [];
	const want = repoSet(repos);
	const rows = await db()
		.select()
		.from(repoMonth)
		.where(
			and(
				inArray(repoMonth.owner, uniq(repos.map((r) => r.owner))),
				inArray(repoMonth.repo, uniq(repos.map((r) => r.repo))),
				inArray(repoMonth.month, months)
			)
		);
	return rows.filter((r) => want.has(`${r.owner}/${r.repo}`));
}

export async function upsertRepoMonths(rows: RepoMonth[]): Promise<void> {
	for (const batch of chunk(rows, 2000)) {
		await db()
			.insert(repoMonth)
			.values(batch)
			.onConflictDoUpdate({
				target: [repoMonth.owner, repoMonth.repo, repoMonth.month],
				set: repoMonthConflictSet()
			});
	}
}

// --- member_repo_month ---
export async function getMemberRepoMonths(
	logins: string[],
	repos: Repo[],
	months: string[]
): Promise<MemberRepoMonthRow[]> {
	if (!logins.length || !repos.length || !months.length) return [];
	const want = repoSet(repos);
	const rows = await db()
		.select()
		.from(memberRepoMonth)
		.where(
			and(
				inArray(memberRepoMonth.login, logins),
				inArray(memberRepoMonth.owner, uniq(repos.map((r) => r.owner))),
				inArray(memberRepoMonth.repo, uniq(repos.map((r) => r.repo))),
				inArray(memberRepoMonth.month, months)
			)
		);
	return rows.filter((r) => want.has(`${r.owner}/${r.repo}`));
}

export async function upsertMemberRepoMonths(rows: MemberRepoMonthRow[]): Promise<void> {
	for (const batch of chunk(rows, 5000)) {
		await db()
			.insert(memberRepoMonth)
			.values(batch)
			.onConflictDoUpdate({
				target: [memberRepoMonth.login, memberRepoMonth.owner, memberRepoMonth.repo, memberRepoMonth.month],
				set: {
					commits: sqlExcluded('commits'),
					mergedPrs: sqlExcluded('merged_prs'),
					additions: sqlExcluded('additions'),
					deletions: sqlExcluded('deletions')
				}
			});
	}
}

// --- review_repo_month ---
export async function getReviewRepoMonths(repos: Repo[], months: string[]): Promise<ReviewRepoMonthRow[]> {
	if (!repos.length || !months.length) return [];
	const want = repoSet(repos);
	const rows = await db()
		.select()
		.from(reviewRepoMonth)
		.where(
			and(
				inArray(reviewRepoMonth.owner, uniq(repos.map((r) => r.owner))),
				inArray(reviewRepoMonth.repo, uniq(repos.map((r) => r.repo))),
				inArray(reviewRepoMonth.month, months)
			)
		);
	return rows.filter((r) => want.has(`${r.owner}/${r.repo}`));
}

export async function upsertReviewRepoMonths(rows: ReviewRepoMonthRow[]): Promise<void> {
	for (const batch of chunk(rows, 5000)) {
		await db()
			.insert(reviewRepoMonth)
			.values(batch)
			.onConflictDoUpdate({
				target: [reviewRepoMonth.reviewer, reviewRepoMonth.owner, reviewRepoMonth.repo, reviewRepoMonth.month],
				set: { reviews: sqlExcluded('reviews'), comments: sqlExcluded('comments') }
			});
	}
}

// onConflict update set for every non-key column of repo_month.
function repoMonthConflictSet() {
	const cols: Record<string, string> = {
		created: 'created',
		merged: 'merged',
		closed: 'closed',
		additions: 'additions',
		deletions: 'deletions',
		addPerPr: 'add_per_pr',
		delPerPr: 'del_per_pr',
		daysPerPr: 'days_per_pr',
		commentsPerPr: 'comments_per_pr',
		reviewsPerPr: 'reviews_per_pr',
		bugs: 'bugs',
		issues: 'issues',
		issuesOpen: 'issues_open',
		bugsOpen: 'bugs_open',
		prsOpen: 'prs_open',
		prsStale: 'prs_stale',
		releases: 'releases',
		resolutionDays: 'resolution_days',
		resolutionStd: 'resolution_std',
		resolutionRate: 'resolution_rate'
	};
	const set: Record<string, unknown> = {};
	for (const [prop, col] of Object.entries(cols)) set[prop] = sqlExcluded(col);
	return set;
}
