// Fact-store sync: a per-repo watermark replaces the legacy per-month staleness
// model. Backfill runs once per repo (extending backwards only when a wider
// window is requested); the steady-state refresh refetches a couple of days of
// overlap tail, so it is far cheaper than refetching a whole in-progress month.
import { env } from '$env/dynamic/private';
import { graphql, type GraphQL } from './github/client';
import {
	fetchPrFactRows,
	fetchIssueFactRows,
	fetchCommitFactRows,
	fetchReviewFactRows,
	fetchReleaseFactRows,
	fetchStockAsOf,
	type DayRange,
} from './github/metrics';
import * as store from './store';
import { addDays, dayOf, monthSlicedRanges, snapshotDays } from './days';
import type { Repo, RepoSyncRow, FactBundle } from './github/types';

// Refresh overlap: a PR merged / issue closed moments before the last sync's
// cutoff must still be caught by the next one.
const OVERLAP_DAYS = 2;

// How long a completed sync is trusted before the tail is refreshed again.
// Falls back to the legacy CURRENT_MONTH_TTL_MS name so existing deployments
// keep their configured cadence.
const ttlEnv = Number(env.SYNC_TTL_MS ?? env.CURRENT_MONTH_TTL_MS);
const SYNC_TTL_MS = Number.isFinite(ttlEnv) && ttlEnv >= 0 ? ttlEnv : 6 * 60 * 60 * 1000;

export type SyncPlan = {
	/** PR/issue ranges to fetch (backfill extension + refresh tail), month-sliced. */
	factRanges: DayRange[];
	/** Commit/review ranges (member window only — the heavy fetches). */
	activityRanges: DayRange[];
	/** Releases are paged newest-first back to this day; null = skip. */
	releaseSince: string | null;
	/** Open-stock snapshot as-of days (backfilled month ends + today). */
	stockDays: string[];
	/** Watermark row to persist once the fetches succeed. */
	next: Omit<RepoSyncRow, 'fetchedAt'>;
};

/**
 * Pure: decide what one repo needs. Returns null when everything is fresh.
 * `spanStartDay` bounds pr/issue/release facts (chart window), `activityStartDay`
 * bounds commit/review facts (member window); both extend backwards over time as
 * wider windows are requested, never shrink.
 */
export function planSync(
	row:
		| (Pick<RepoSyncRow, 'backfilledFrom' | 'activityBackfilledFrom' | 'syncedThrough'> & {
				fetchedAt: Date;
		  })
		| null,
	spanStartDay: string,
	activityStartDay: string,
	todayDay: string,
	nowMs: number,
	force = false,
):
	| (Omit<SyncPlan, 'next'> & {
			next: Omit<RepoSyncRow, 'fetchedAt' | 'owner' | 'repo'>;
	  })
	| null {
	if (!row) {
		// First sight of this repo: backfill everything up to today.
		return {
			factRanges: monthSlicedRanges(spanStartDay, todayDay),
			activityRanges: monthSlicedRanges(activityStartDay, todayDay),
			releaseSince: spanStartDay,
			stockDays: snapshotDays(spanStartDay, todayDay),
			next: {
				backfilledFrom: spanStartDay,
				activityBackfilledFrom: activityStartDay,
				syncedThrough: todayDay,
			},
		};
	}

	const factRanges: DayRange[] = [];
	const activityRanges: DayRange[] = [];
	const stockDaysOut: string[] = [];
	let releaseSince: string | null = null;

	// Backwards extensions: a wider window than ever synced before.
	if (spanStartDay < row.backfilledFrom) {
		const to = addDays(row.backfilledFrom, -1);
		factRanges.push(...monthSlicedRanges(spanStartDay, to));
		stockDaysOut.push(...snapshotDays(spanStartDay, to));
		releaseSince = spanStartDay;
	}
	if (activityStartDay < row.activityBackfilledFrom) {
		activityRanges.push(
			...monthSlicedRanges(activityStartDay, addDays(row.activityBackfilledFrom, -1)),
		);
	}

	// Recent tail: stale once the watermark day passed or the TTL expired.
	const stale =
		force || row.syncedThrough < todayDay || nowMs - row.fetchedAt.getTime() > SYNC_TTL_MS;
	if (stale) {
		const from = addDays(
			row.syncedThrough < todayDay ? row.syncedThrough : todayDay,
			-OVERLAP_DAYS,
		);
		const tail = monthSlicedRanges(from, todayDay);
		factRanges.push(...tail);
		activityRanges.push(...tail);
		stockDaysOut.push(todayDay);
		if (releaseSince === null) releaseSince = from;
	}

	if (!factRanges.length && !activityRanges.length) return null;
	return {
		factRanges,
		activityRanges,
		releaseSince,
		stockDays: [...new Set(stockDaysOut)],
		next: {
			backfilledFrom: spanStartDay < row.backfilledFrom ? spanStartDay : row.backfilledFrom,
			activityBackfilledFrom:
				activityStartDay < row.activityBackfilledFrom
					? activityStartDay
					: row.activityBackfilledFrom,
			syncedThrough: stale ? todayDay : row.syncedThrough,
		},
	};
}

/** Fetch one repo's planned ranges and persist facts + the advanced watermark. */
async function executeSync(
	gql: GraphQL,
	repo: Repo,
	plan: NonNullable<ReturnType<typeof planSync>>,
	bugLabels: string[],
): Promise<void> {
	const [prs, issues, reviews, releases, stocks] = await Promise.all([
		plan.factRanges.length ? fetchPrFactRows(gql, repo, plan.factRanges) : [],
		plan.factRanges.length ? fetchIssueFactRows(gql, repo, plan.factRanges) : [],
		plan.activityRanges.length ? fetchReviewFactRows(gql, repo, plan.activityRanges) : [],
		plan.releaseSince ? fetchReleaseFactRows(gql, repo, plan.releaseSince) : [],
		plan.stockDays.length ? fetchStockAsOf(gql, repo, plan.stockDays, bugLabels) : [],
	]);
	// Commit fetches nest heavy history queries; run ranges sequentially so one
	// repo cannot burst the shared GraphQL budget.
	const commits = [];
	for (const range of plan.activityRanges)
		commits.push(...(await fetchCommitFactRows(gql, repo, range)));

	await Promise.all([
		store.upsertPrFacts(prs),
		store.upsertIssueFacts(issues),
		store.upsertReviewFacts(reviews),
		store.upsertCommitFacts(commits),
		store.upsertReleaseFacts(releases),
		store.upsertStockDays(stocks),
	]);
	await store.upsertRepoSync({
		owner: repo.owner,
		repo: repo.repo,
		...plan.next,
	});
}

export type SyncResult = {
	synced: number;
	refreshed: number;
	failed: { repo: string; error: Error }[];
};

/**
 * Bring every repo's facts up to date for the requested window (no-op for fresh
 * repos). Per-repo isolation: one failing repo (rate limit blip) never sinks the
 * others — the report serves what is stored.
 */
export async function ensureFactsSynced(
	repos: Repo[],
	spanStartDay: string,
	activityStartDay: string,
	opts: { force?: boolean; bugLabels?: string[]; now?: Date } = {},
	gql: GraphQL = graphql,
): Promise<SyncResult> {
	if (!repos.length) return { synced: 0, refreshed: 0, failed: [] };
	const now = opts.now ?? new Date();
	const todayDay = dayOf(now);
	const syncRows = await store.getRepoSyncRows(repos);
	const rowByRepo = new Map(syncRows.map((r) => [`${r.owner}/${r.repo}`, r]));

	let refreshed = 0;
	const failed: { repo: string; error: Error }[] = [];
	await Promise.all(
		repos.map(async (repo) => {
			const plan = planSync(
				rowByRepo.get(`${repo.owner}/${repo.repo}`) ?? null,
				spanStartDay,
				activityStartDay,
				todayDay,
				now.getTime(),
				opts.force,
			);
			if (!plan) return;
			try {
				await executeSync(gql, repo, plan, opts.bugLabels ?? []);
				refreshed += 1;
			} catch (e) {
				failed.push({ repo: `${repo.owner}/${repo.repo}`, error: e as Error });
			}
		}),
	);
	return { synced: repos.length, refreshed, failed };
}

/** Live (no-DB) path: fetch the whole bundle for the window with no persistence. */
export async function fetchFactBundleLive(
	gql: GraphQL,
	repos: Repo[],
	spanStartDay: string,
	activityStartDay: string,
	todayDay: string,
	bugLabels: string[],
): Promise<FactBundle> {
	const factRanges = monthSlicedRanges(spanStartDay, todayDay);
	const activityRanges = monthSlicedRanges(activityStartDay, todayDay);
	const bundles = await Promise.all(
		repos.map(async (repo) => {
			const [prs, issues, reviews, releases, stocks] = await Promise.all([
				fetchPrFactRows(gql, repo, factRanges),
				fetchIssueFactRows(gql, repo, factRanges),
				fetchReviewFactRows(gql, repo, activityRanges),
				fetchReleaseFactRows(gql, repo, spanStartDay),
				fetchStockAsOf(gql, repo, snapshotDays(spanStartDay, todayDay), bugLabels),
			]);
			const commits = [];
			for (const range of activityRanges)
				commits.push(...(await fetchCommitFactRows(gql, repo, range)));
			return { prs, issues, commits, reviews, releases, stocks };
		}),
	);
	return {
		prs: bundles.flatMap((b) => b.prs),
		issues: bundles.flatMap((b) => b.issues),
		commits: bundles.flatMap((b) => b.commits),
		reviews: bundles.flatMap((b) => b.reviews),
		releases: bundles.flatMap((b) => b.releases),
		stocks: bundles.flatMap((b) => b.stocks),
	};
}
