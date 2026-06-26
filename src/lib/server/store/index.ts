import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { repoMonth, memberRepoMonth, reviewRepoMonth } from '../db/schema';
import type { Repo, RepoMonth } from '../github/types';
import type { MemberRepoMonthRow, ReviewRepoMonthRow } from './assemble';

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const repoSet = (repos: Repo[]) => new Set(repos.map((r) => `${r.owner}/${r.repo}`));
const owners = (repos: Repo[]) => uniq(repos.map((r) => r.owner));
const repoNames = (repos: Repo[]) => uniq(repos.map((r) => r.repo));
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

// fetched_at is internal cache metadata; strip it from rows returned for reports
// so it never leaks into the API payload.
function stripFetchedAt<T extends { fetchedAt?: unknown }>(rows: T[]): T[] {
	return rows.map((r) => {
		const copy = { ...r };
		delete (copy as { fetchedAt?: unknown }).fetchedAt;
		return copy;
	});
}

// --- repo_month ---
export async function getRepoMonths(repos: Repo[], months: string[]): Promise<RepoMonth[]> {
	if (!repos.length || !months.length) return [];
	const want = repoSet(repos);
	const rows = await db()
		.select()
		.from(repoMonth)
		.where(
			and(
				inArray(repoMonth.owner, owners(repos)),
				inArray(repoMonth.repo, repoNames(repos)),
				inArray(repoMonth.month, months)
			)
		);
	return stripFetchedAt(rows.filter((r) => want.has(`${r.owner}/${r.repo}`)));
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

/** Map of `${owner}/${repo}::${month}` → when that row was last fetched, for the
 * requested repos+months. Drives the "is this month still fresh?" decision. */
export async function repoMonthFetchedAt(repos: Repo[], months: string[]): Promise<Map<string, Date>> {
	const out = new Map<string, Date>();
	if (!repos.length || !months.length) return out;
	const want = repoSet(repos);
	const rows = await db()
		.select({ owner: repoMonth.owner, repo: repoMonth.repo, month: repoMonth.month, fetchedAt: repoMonth.fetchedAt })
		.from(repoMonth)
		.where(
			and(
				inArray(repoMonth.owner, owners(repos)),
				inArray(repoMonth.repo, repoNames(repos)),
				inArray(repoMonth.month, months)
			)
		);
	for (const r of rows) if (want.has(`${r.owner}/${r.repo}`)) out.set(`${r.owner}/${r.repo}::${r.month}`, r.fetchedAt);
	return out;
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
				inArray(memberRepoMonth.owner, owners(repos)),
				inArray(memberRepoMonth.repo, repoNames(repos)),
				inArray(memberRepoMonth.month, months)
			)
		);
	return stripFetchedAt(rows.filter((r) => want.has(`${r.owner}/${r.repo}`)));
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
					deletions: sqlExcluded('deletions'),
					fetchedAt: sql`now()`
				}
			});
	}
}

/** Map of `${login}::${owner}/${repo}::${month}` → when that row was last fetched. */
export async function memberMonthFetchedAt(
	logins: string[],
	repos: Repo[],
	months: string[]
): Promise<Map<string, Date>> {
	const out = new Map<string, Date>();
	if (!logins.length || !repos.length || !months.length) return out;
	const want = repoSet(repos);
	const rows = await db()
		.select({
			login: memberRepoMonth.login,
			owner: memberRepoMonth.owner,
			repo: memberRepoMonth.repo,
			month: memberRepoMonth.month,
			fetchedAt: memberRepoMonth.fetchedAt
		})
		.from(memberRepoMonth)
		.where(
			and(
				inArray(memberRepoMonth.login, logins),
				inArray(memberRepoMonth.owner, owners(repos)),
				inArray(memberRepoMonth.repo, repoNames(repos)),
				inArray(memberRepoMonth.month, months)
			)
		);
	for (const r of rows)
		if (want.has(`${r.owner}/${r.repo}`)) out.set(`${r.login}::${r.owner}/${r.repo}::${r.month}`, r.fetchedAt);
	return out;
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
				inArray(reviewRepoMonth.owner, owners(repos)),
				inArray(reviewRepoMonth.repo, repoNames(repos)),
				inArray(reviewRepoMonth.month, months)
			)
		);
	return stripFetchedAt(rows.filter((r) => want.has(`${r.owner}/${r.repo}`)));
}

export async function upsertReviewRepoMonths(rows: ReviewRepoMonthRow[]): Promise<void> {
	for (const batch of chunk(rows, 5000)) {
		await db()
			.insert(reviewRepoMonth)
			.values(batch)
			.onConflictDoUpdate({
				target: [reviewRepoMonth.reviewer, reviewRepoMonth.owner, reviewRepoMonth.repo, reviewRepoMonth.month],
				set: { reviews: sqlExcluded('reviews'), comments: sqlExcluded('comments'), fetchedAt: sql`now()` }
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
	set.fetchedAt = sql`now()`;
	return set;
}
