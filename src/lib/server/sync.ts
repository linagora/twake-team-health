// Fact-store sync: a per-repo watermark replaces the legacy per-month staleness
// model. Backfill runs once per repo (extending backwards only when a wider
// window is requested); the steady-state refresh refetches a couple of days of
// overlap tail, so it is far cheaper than refetching a whole in-progress month.
// Tail-only refreshes can run in the background (stale-while-revalidate) so an
// interactive report never waits on GitHub for data it already has.
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
	/** Reconcile late label/issue-type edits on a refresh: re-pull in-span issues
	 * updated since this day, regardless of when they were created. Null on the
	 * first backfill (everything is freshly created-fetched) and when not stale. */
	issueReconcile: { updatedSince: string; createdFrom: string } | null;
	/** Commit ranges (member window only — the heaviest fetches). */
	activityRanges: DayRange[];
	/** Review ranges (flow window; wider than commits, cheaper per month). */
	reviewRanges: DayRange[];
	/** Releases are paged newest-first back to this day; null = skip. */
	releaseSince: string | null;
	/** Open-stock snapshot as-of days (backfilled month ends + today). */
	stockDays: string[];
	/** True when any range extends history backwards (missing data, must block);
	 * false = tail-only refresh (stored data is complete, refresh may background). */
	hasBackfill: boolean;
	/** Watermark row to persist once the fetches succeed. */
	next: Omit<RepoSyncRow, 'fetchedAt' | 'owner' | 'repo'>;
};

// Legacy rows (review_backfilled_from IS NULL) predate the bot/comment fields
// on review facts, so their stored review rows are not trustworthy for flow.
// Treating them as having NO review coverage forces one full, self-healing
// refetch — the id-keyed upsert rewrites every row with the new fields.

/**
 * Pure: decide what one repo needs. Returns null when everything is fresh.
 * `spanStartDay` bounds pr/issue/release facts (chart window), `activityStartDay`
 * bounds commit facts (member window), `reviewStartDay` bounds review facts
 * (flow window). All extend backwards over time as wider windows are requested,
 * never shrink.
 */
export function planSync(
	row:
		| (Pick<
				RepoSyncRow,
				'backfilledFrom' | 'activityBackfilledFrom' | 'reviewBackfilledFrom' | 'syncedThrough'
		  > & { fetchedAt: Date })
		| null,
	spanStartDay: string,
	activityStartDay: string,
	reviewStartDay: string,
	todayDay: string,
	nowMs: number,
	force = false,
): SyncPlan | null {
	if (!row) {
		// First sight of this repo: backfill everything up to today.
		return {
			factRanges: monthSlicedRanges(spanStartDay, todayDay),
			issueReconcile: null,
			activityRanges: monthSlicedRanges(activityStartDay, todayDay),
			reviewRanges: monthSlicedRanges(reviewStartDay, todayDay),
			releaseSince: spanStartDay,
			stockDays: snapshotDays(spanStartDay, todayDay),
			hasBackfill: true,
			next: {
				backfilledFrom: spanStartDay,
				activityBackfilledFrom: activityStartDay,
				reviewBackfilledFrom: reviewStartDay,
				syncedThrough: todayDay,
			},
		};
	}

	const factRanges: DayRange[] = [];
	const activityRanges: DayRange[] = [];
	const reviewRanges: DayRange[] = [];
	const stockDaysOut: string[] = [];
	let releaseSince: string | null = null;
	let issueReconcile: SyncPlan['issueReconcile'] = null;
	// Widest span ever synced for this repo: the created lower bound for reconcile.
	const backfilledFrom = spanStartDay < row.backfilledFrom ? spanStartDay : row.backfilledFrom;

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
	if (row.reviewBackfilledFrom === null) {
		reviewRanges.push(...monthSlicedRanges(reviewStartDay, todayDay));
	} else if (reviewStartDay < row.reviewBackfilledFrom) {
		reviewRanges.push(...monthSlicedRanges(reviewStartDay, addDays(row.reviewBackfilledFrom, -1)));
	}
	const hasBackfill = factRanges.length > 0 || activityRanges.length > 0 || reviewRanges.length > 0;

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
		reviewRanges.push(...tail);
		stockDaysOut.push(todayDay);
		if (releaseSince === null) releaseSince = from;
		// Late label/type edits on older in-span issues are invisible to the
		// created/closed tail; reconcile them by their update time.
		issueReconcile = { updatedSince: from, createdFrom: backfilledFrom };
	}

	if (!factRanges.length && !activityRanges.length && !reviewRanges.length) return null;
	return {
		factRanges,
		issueReconcile,
		activityRanges,
		reviewRanges,
		releaseSince,
		stockDays: [...new Set(stockDaysOut)],
		hasBackfill,
		next: {
			backfilledFrom,
			activityBackfilledFrom:
				activityStartDay < row.activityBackfilledFrom
					? activityStartDay
					: row.activityBackfilledFrom,
			reviewBackfilledFrom:
				row.reviewBackfilledFrom === null || reviewStartDay < row.reviewBackfilledFrom
					? reviewStartDay
					: row.reviewBackfilledFrom,
			syncedThrough: stale ? todayDay : row.syncedThrough,
		},
	};
}

/** Fetch one repo's planned ranges and persist facts + the advanced watermark. */
async function executeSync(
	gql: GraphQL,
	repo: Repo,
	plan: SyncPlan,
	bugLabels: string[],
): Promise<void> {
	// Everything in parallel — the GraphQL client's semaphore is the global
	// throttle, so per-repo serialization only added wall-clock.
	const [prs, issues, reviews, releases, stocks, commitBatches] = await Promise.all([
		plan.factRanges.length ? fetchPrFactRows(gql, repo, plan.factRanges) : [],
		plan.factRanges.length || plan.issueReconcile
			? fetchIssueFactRows(gql, repo, plan.factRanges, plan.issueReconcile ?? undefined)
			: [],
		plan.reviewRanges.length ? fetchReviewFactRows(gql, repo, plan.reviewRanges) : [],
		plan.releaseSince ? fetchReleaseFactRows(gql, repo, plan.releaseSince) : [],
		plan.stockDays.length ? fetchStockAsOf(gql, repo, plan.stockDays, bugLabels) : [],
		Promise.all(plan.activityRanges.map((range) => fetchCommitFactRows(gql, repo, range))),
	]);
	const commits = commitBatches.flat();

	await Promise.all([
		store.upsertPrFacts(prs),
		store.upsertIssueFacts(issues),
		store.upsertReviewFacts(reviews),
		store.upsertCommitFacts(commits),
		store.upsertReleaseFacts(releases),
		store.upsertStockDays(stocks),
	]);
	await store.upsertRepoSync({ owner: repo.owner, repo: repo.repo, ...plan.next });
}

export type SyncResult = {
	synced: number;
	refreshed: number;
	/** Tail refreshes handed to the background (stale-while-revalidate). */
	backgrounded: number;
	failed: { repo: string; error: Error }[];
};

// One in-flight background refresh per repo, so concurrent stale reads don't
// each re-fetch the same tail.
const inflight = new Map<string, Promise<void>>();

export type SyncOptions = {
	force?: boolean;
	bugLabels?: string[];
	now?: Date;
	/** Stale-while-revalidate: run tail-only refreshes in the background and
	 * return immediately (backfills that would leave holes still block). */
	swr?: boolean;
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
	reviewStartDay: string = activityStartDay,
	opts: SyncOptions = {},
	gql: GraphQL = graphql,
): Promise<SyncResult> {
	if (!repos.length) return { synced: 0, refreshed: 0, backgrounded: 0, failed: [] };
	const now = opts.now ?? new Date();
	const todayDay = dayOf(now);
	const syncRows = await store.getRepoSyncRows(repos);
	const rowByRepo = new Map(syncRows.map((r) => [`${r.owner}/${r.repo}`, r]));

	let refreshed = 0;
	let backgrounded = 0;
	const failed: { repo: string; error: Error }[] = [];
	await Promise.all(
		repos.map(async (repo) => {
			const key = `${repo.owner}/${repo.repo}`;
			const plan = planSync(
				rowByRepo.get(key) ?? null,
				spanStartDay,
				activityStartDay,
				reviewStartDay,
				todayDay,
				now.getTime(),
				opts.force,
			);
			if (!plan) return;
			// Tail-only refresh under SWR: kick it off (deduped) and serve stored
			// facts now. Backfills must block — serving zero-filled history as if it
			// were real would be worse than waiting.
			if (opts.swr && !plan.hasBackfill && !opts.force) {
				if (!inflight.has(key)) {
					const job = executeSync(gql, repo, plan, opts.bugLabels ?? [])
						.catch((e) =>
							console.warn(`[sync] background refresh failed for ${key}: ${(e as Error).message}`),
						)
						.finally(() => inflight.delete(key));
					inflight.set(key, job);
				}
				backgrounded += 1;
				return;
			}
			try {
				await executeSync(gql, repo, plan, opts.bugLabels ?? []);
				refreshed += 1;
			} catch (e) {
				failed.push({ repo: key, error: e as Error });
			}
		}),
	);
	return { synced: repos.length, refreshed, backgrounded, failed };
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
			const [prs, issues, reviews, releases, stocks, commitBatches] = await Promise.all([
				fetchPrFactRows(gql, repo, factRanges),
				fetchIssueFactRows(gql, repo, factRanges),
				fetchReviewFactRows(gql, repo, activityRanges),
				fetchReleaseFactRows(gql, repo, spanStartDay),
				fetchStockAsOf(gql, repo, snapshotDays(spanStartDay, todayDay), bugLabels),
				Promise.all(activityRanges.map((range) => fetchCommitFactRows(gql, repo, range))),
			]);
			return { prs, issues, commits: commitBatches.flat(), reviews, releases, stocks };
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
