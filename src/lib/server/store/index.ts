import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
	prFact,
	issueFact,
	commitFact,
	reviewFact,
	releaseFact,
	repoStockDay,
	repoSync,
} from '../db/schema';
import type {
	Repo,
	PrFact,
	IssueFact,
	CommitFact,
	ReviewFact,
	ReleaseFact,
	StockDay,
	RepoSyncRow,
	FactBundle,
} from '../github/types';

const repoSet = (repos: Repo[]) => new Set(repos.map((r) => `${r.owner}/${r.repo}`));
// Postgres caps a statement at 65535 bind parameters, so inserts are batched.
// Sizes leave headroom for each table's column count.
const chunk = <T>(xs: T[], n: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
	return out;
};
// On-conflict updates copy from the row we tried to insert ("excluded").
const sqlExcluded = (col: string) => sql.raw(`excluded.${col}`);

// Exact (owner, repo) pair predicate — an OR of per-repo ANDs, so the planner
// matches only the requested repos instead of the owner×name cross product.
const repoPairs = (t: { owner: any; repo: any }, repos: Repo[]) =>
	or(...repos.map((r) => and(eq(t.owner, r.owner), eq(t.repo, r.repo))))!;
// Belt-and-braces re-filter for callers that pass duplicate repo entries.
const filterRepos = <T extends { owner: string; repo: string }>(rows: T[], repos: Repo[]): T[] => {
	const want = repoSet(repos);
	return rows.filter((r) => want.has(`${r.owner}/${r.repo}`));
};

// --- fact upserts (idempotent; refetching a range re-seen is a no-op) --------

export async function upsertPrFacts(rows: PrFact[]): Promise<void> {
	for (const batch of chunk(rows, 4000)) {
		await db()
			.insert(prFact)
			.values(batch)
			.onConflictDoUpdate({
				target: [prFact.owner, prFact.repo, prFact.number],
				set: {
					author: sqlExcluded('author'),
					createdAt: sqlExcluded('created_at'),
					mergedAt: sqlExcluded('merged_at'),
					closedAt: sqlExcluded('closed_at'),
					additions: sqlExcluded('additions'),
					deletions: sqlExcluded('deletions'),
					comments: sqlExcluded('comments'),
					reviews: sqlExcluded('reviews'),
					fetchedAt: sql`now()`,
				},
			});
	}
}

export async function upsertIssueFacts(rows: IssueFact[]): Promise<void> {
	for (const batch of chunk(rows, 6000)) {
		await db()
			.insert(issueFact)
			.values(batch)
			.onConflictDoUpdate({
				target: [issueFact.owner, issueFact.repo, issueFact.number],
				set: {
					createdAt: sqlExcluded('created_at'),
					closedAt: sqlExcluded('closed_at'),
					labels: sqlExcluded('labels'),
					fetchedAt: sql`now()`,
				},
			});
	}
}

export async function upsertCommitFacts(rows: CommitFact[]): Promise<void> {
	// Commits are immutable; re-seeing a SHA carries no new information.
	for (const batch of chunk(rows, 6000)) {
		await db().insert(commitFact).values(batch).onConflictDoNothing();
	}
}

export async function upsertReviewFacts(rows: ReviewFact[]): Promise<void> {
	for (const batch of chunk(rows, 5000)) {
		await db()
			.insert(reviewFact)
			.values(batch)
			.onConflictDoUpdate({
				target: [reviewFact.owner, reviewFact.repo, reviewFact.id],
				set: {
					state: sqlExcluded('state'),
					isBot: sqlExcluded('is_bot'),
					avatarUrl: sqlExcluded('avatar_url'),
					commentsCount: sqlExcluded('comments_count'),
					ts: sqlExcluded('ts'),
				},
			});
	}
}

export async function upsertReleaseFacts(rows: ReleaseFact[]): Promise<void> {
	for (const batch of chunk(rows, 8000)) {
		await db()
			.insert(releaseFact)
			.values(batch)
			.onConflictDoUpdate({
				target: [releaseFact.owner, releaseFact.repo, releaseFact.tag],
				set: { publishedAt: sqlExcluded('published_at') },
			});
	}
}

export async function upsertStockDays(rows: StockDay[]): Promise<void> {
	for (const batch of chunk(rows, 8000)) {
		await db()
			.insert(repoStockDay)
			.values(batch)
			.onConflictDoUpdate({
				target: [repoStockDay.owner, repoStockDay.repo, repoStockDay.day],
				set: {
					issuesOpen: sqlExcluded('issues_open'),
					bugsOpen: sqlExcluded('bugs_open'),
					prsOpen: sqlExcluded('prs_open'),
					fetchedAt: sql`now()`,
				},
			});
	}
}

// --- sync watermarks ----------------------------------------------------------

export async function getRepoSyncRows(repos: Repo[]): Promise<RepoSyncRow[]> {
	if (!repos.length) return [];
	const rows = await db().select().from(repoSync).where(repoPairs(repoSync, repos));
	return filterRepos(rows, repos);
}

export async function upsertRepoSync(row: Omit<RepoSyncRow, 'fetchedAt'>): Promise<void> {
	await db()
		.insert(repoSync)
		.values(row)
		.onConflictDoUpdate({
			target: [repoSync.owner, repoSync.repo],
			set: {
				backfilledFrom: sqlExcluded('backfilled_from'),
				activityBackfilledFrom: sqlExcluded('activity_backfilled_from'),
				reviewBackfilledFrom: sqlExcluded('review_backfilled_from'),
				syncedThrough: sqlExcluded('synced_through'),
				fetchedAt: sql`now()`,
			},
		});
}

// --- fact reads (one bundle per report) ---------------------------------------

/**
 * Everything the aggregator needs, in parallel. `start`/`end` bound the report
 * span (oldest chart month .. now); `activityStart` separately bounds the
 * heavier commit/review facts to the member window.
 * PR/issue facts use an open-interval predicate — an item created before the
 * span still matters while it is open (stock) or if it closed inside the span.
 */
export async function readFactBundle(
	repos: Repo[],
	start: Date,
	activityStart: Date,
	end: Date,
): Promise<FactBundle> {
	if (!repos.length) {
		return {
			prs: [],
			issues: [],
			commits: [],
			reviews: [],
			releases: [],
			stocks: [],
		};
	}
	const ownerIn = <T extends { owner: any; repo: any }>(t: T) => repoPairs(t, repos);

	const [prs, issues, commits, reviews, releases, stocks] = await Promise.all([
		db()
			.select()
			.from(prFact)
			.where(
				and(
					ownerIn(prFact),
					lte(prFact.createdAt, end),
					or(isNull(prFact.closedAt), gte(prFact.closedAt, start)),
				),
			),
		db()
			.select()
			.from(issueFact)
			.where(
				and(
					ownerIn(issueFact),
					lte(issueFact.createdAt, end),
					or(isNull(issueFact.closedAt), gte(issueFact.closedAt, start)),
				),
			),
		db()
			.select()
			.from(commitFact)
			.where(
				and(
					ownerIn(commitFact),
					gte(commitFact.committedAt, activityStart),
					lte(commitFact.committedAt, end),
				),
			),
		db()
			.select()
			.from(reviewFact)
			.where(and(ownerIn(reviewFact), gte(reviewFact.ts, activityStart), lte(reviewFact.ts, end))),
		db()
			.select()
			.from(releaseFact)
			.where(
				and(
					ownerIn(releaseFact),
					gte(releaseFact.publishedAt, start),
					lte(releaseFact.publishedAt, end),
				),
			),
		// Stock snapshots are sparse (month ends + recent days); read the span's
		// worth for the repo set and pick per-bucket in the aggregator. The day
		// bound keeps this from scanning years of daily snapshots as history grows.
		db()
			.select()
			.from(repoStockDay)
			.where(and(ownerIn(repoStockDay), gte(repoStockDay.day, start.toISOString().slice(0, 10)))),
	]);

	return {
		prs: filterRepos(prs, repos),
		issues: filterRepos(issues, repos),
		commits: filterRepos(commits, repos),
		reviews: filterRepos(reviews, repos) as ReviewFact[],
		releases: filterRepos(releases, repos),
		stocks: filterRepos(stocks, repos),
	};
}

// --- flow facts (merged cohort + its review timeline) --------------------------

/**
 * The merged-PR cohort for a window plus every review event on those repos back
 * to the cohort's earliest open time, so first-review/approval instants that
 * precede the window are not lost. Two steps because the review lower bound
 * depends on the cohort's oldest createdAt.
 */
export async function readFlowFacts(
	repos: Repo[],
	start: Date,
	end: Date,
): Promise<{ prs: PrFact[]; reviews: ReviewFact[] }> {
	if (!repos.length) return { prs: [], reviews: [] };
	const prs = filterRepos(
		await db()
			.select()
			.from(prFact)
			.where(and(repoPairs(prFact, repos), gte(prFact.mergedAt, start), lte(prFact.mergedAt, end))),
		repos,
	);
	if (!prs.length) return { prs, reviews: [] };
	const oldestOpen = prs.reduce(
		(min, p) => (p.createdAt < min ? p.createdAt : min),
		prs[0].createdAt,
	);
	const reviews = filterRepos(
		await db()
			.select()
			.from(reviewFact)
			.where(
				and(repoPairs(reviewFact, repos), gte(reviewFact.ts, oldestOpen), lte(reviewFact.ts, end)),
			),
		repos,
	) as ReviewFact[];
	return { prs, reviews };
}

// --- sync tooling (admin visibility + full re-sync) ----------------------------

export type RepoSyncStatus = RepoSyncRow & {
	prFacts: number;
	commitFacts: number;
	reviewFacts: number;
};

/** Every repo watermark plus its fact counts, for the admin sync panel. */
export async function getSyncStatus(): Promise<RepoSyncStatus[]> {
	const countsBy = async (table: typeof prFact | typeof commitFact | typeof reviewFact) => {
		const rows = await db()
			.select({ owner: table.owner, repo: table.repo, n: sql<number>`count(*)::int` })
			.from(table)
			.groupBy(table.owner, table.repo);
		return new Map(rows.map((r) => [`${r.owner}/${r.repo}`, r.n]));
	};
	const [syncRows, prs, commits, reviews] = await Promise.all([
		db().select().from(repoSync),
		countsBy(prFact),
		countsBy(commitFact),
		countsBy(reviewFact),
	]);
	return syncRows
		.map((r) => {
			const k = `${r.owner}/${r.repo}`;
			return {
				...r,
				prFacts: prs.get(k) ?? 0,
				commitFacts: commits.get(k) ?? 0,
				reviewFacts: reviews.get(k) ?? 0,
			};
		})
		.sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`));
}

/** Drop a repo's watermark so its whole history is refetched from scratch (the
 * facts stay; the id/number-keyed upserts rewrite them in place). */
export async function deleteRepoSync(repo: Repo): Promise<void> {
	await db()
		.delete(repoSync)
		.where(and(eq(repoSync.owner, repo.owner), eq(repoSync.repo, repo.repo)));
}
