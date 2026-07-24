// Report orchestrator over the fact store. Facts are synced per repo (watermark
// model, see sync.ts), read once, and aggregated at read time into:
//   - calendar-month buckets covering the full requested window THROUGH TODAY
//     (the in-progress month is an extra bucket, rendered by charts as a partial
//     trailing point and counted by sums, signals and leaderboards, so nothing is
//     cut off at a month boundary; anything that COMPARES months to each other,
//     a median, an average or a month-over-month delta, drops it first via
//     completeMonths),
//   - rolling trailing-30d headline + per-member numbers (window30d /
//     recentMembers), which always span a full 30 days.
// With no DATABASE_URL it falls back to fetching facts live on every request.
import { graphql, type GraphQL } from './github/client';
import { monthsEndingAt, monthEnd, type Month } from './github/months';
import { makeBugMatcher } from './github/stats';
import { assembleMetrics } from './store/assemble';
import { buildStoredRows, aggregateRecent } from './store/aggregate';
import { excludeReleases, globalNoReleaseRepos } from './release-exclusions';
import * as store from './store';
import { ensureFactsSynced, fetchFactBundleLive } from './sync';
import { hasDb } from './db';
import { getAppSettings } from './app-config';
import { dayOf, dayStartMs, addDays, WINDOW_DAYS } from './days';
import { monthKeyOf } from '$lib/months';
import type { Selection, MetricsResult, FactBundle } from './github/types';

export type ReportShape = {
	/** Repo-series buckets, ascending: N complete months + the in-progress month
	 * on rolling selections (charts plot the partial bucket as the trailing point). */
	months: Month[];
	/** Member/review-series buckets, ascending (same rule). */
	memberMonths: Month[];
	/** Rolling windows end here (today, or the historical `to` month's end). */
	windowEndDay: string;
	/** Oldest day pr/issue/release facts must cover. */
	spanStartDay: string;
	/** Oldest day commit/review facts must cover. */
	activityStartDay: string;
};

/**
 * Pure: resolve a selection into month buckets and fact-span bounds.
 * A rolling selection ends at the in-progress month so every surface reaches
 * today; an explicit historical `to` ends there instead (all months complete).
 * The rolling windows end at today, or at the historical month's end.
 */
export function resolveReportShape(selection: Selection, now: Date): ReportShape {
	const current = monthKeyOf(now);
	const historical = selection.to !== undefined && selection.to < current;
	// Rolling selections bucket the requested N COMPLETE months PLUS the
	// in-progress month as an extra bucket, so every surface (charts, sums,
	// signals, leaderboards) runs through today rather than stopping at the
	// last month end.
	// An explicit historical `to` is honored as-is (all its months are complete).
	const endKey = historical ? selection.to! : current;
	const extra = historical ? 0 : 1;
	const months = monthsEndingAt(endKey, selection.months + extra);
	const memberMonths = monthsEndingAt(
		endKey,
		Math.min(selection.memberMonths, selection.months) + extra,
	);

	const todayDay = dayOf(now);
	const windowEndDay = historical ? monthEnd(months[months.length - 1]) : todayDay;
	// The previous rolling window reaches 2N-1 days back from its end.
	const windowStartDay = addDays(windowEndDay, -(2 * WINDOW_DAYS - 1));

	const monthsStart = `${months[0].year}-${String(months[0].month).padStart(2, '0')}-01`;
	const memberStart = `${memberMonths[0].year}-${String(memberMonths[0].month).padStart(2, '0')}-01`;
	return {
		months,
		memberMonths,
		windowEndDay,
		spanStartDay: windowStartDay < monthsStart ? windowStartDay : monthsStart,
		activityStartDay: windowStartDay < memberStart ? windowStartDay : memberStart,
	};
}

/** Build the full report for a selection (cached upstream by metrics-cache). */
export async function getReport(
	selection: Selection,
	now: Date = new Date(),
	gql: GraphQL = graphql,
): Promise<MetricsResult> {
	const shape = resolveReportShape(selection, now);
	const { bugLabels, bugIssueTypes } = await getAppSettings();
	const isBug = makeBugMatcher({ bugLabels, bugIssueTypes });
	const todayDay = dayOf(now);

	let bundle: FactBundle;
	if (!hasDb()) {
		console.warn(
			'[report] DATABASE_URL is not set: fetching all facts live with no persistence. ' +
				'Set DATABASE_URL so facts are stored once and refreshed incrementally.',
		);
		bundle = await fetchFactBundleLive(
			gql,
			selection.repos,
			shape.spanStartDay,
			shape.activityStartDay,
			todayDay,
			bugLabels,
		);
	} else {
		// Reviews follow the member window here; the flow report widens the review
		// watermark on demand. Tail refreshes run in the background (SWR) so an
		// interactive report never blocks on GitHub for data it already has.
		const sync = await ensureFactsSynced(
			selection.repos,
			shape.spanStartDay,
			shape.activityStartDay,
			shape.activityStartDay,
			{ bugLabels, now, swr: true },
			gql,
		);
		bundle = await store.readFactBundle(
			selection.repos,
			new Date(dayStartMs(shape.spanStartDay)),
			new Date(dayStartMs(shape.activityStartDay)),
			now,
		);
		if (sync.failed.length) {
			// Partial sync: serve what is stored — unless there is nothing at all to
			// serve, in which case surface the fetch error (rate limit etc.).
			if (!bundle.prs.length && !bundle.issues.length && !bundle.commits.length) {
				throw sync.failed[0].error;
			}
			console.warn(
				`[report] sync partial (${sync.failed.length}/${selection.repos.length} repos failed), serving stored facts: ${sync.failed[0].error.message}`,
			);
		}
		console.info(
			`[report] repos=${selection.repos.length} months=${shape.months.length} refreshed=${sync.refreshed}/${sync.synced} background=${sync.backgrounded}`,
		);
	}

	const rows = buildStoredRows(bundle, {
		repos: selection.repos,
		members: selection.members,
		months: shape.months,
		memberMonths: shape.memberMonths,
		isBug,
	});
	const metrics = assembleMetrics(
		{
			...rows,
			repoRows: excludeReleases(rows.repoRows, selection.repos, globalNoReleaseRepos()),
		},
		selection.members,
		now.getTime(),
	);
	const recent = aggregateRecent(
		bundle,
		selection.repos,
		selection.members,
		isBug,
		shape.windowEndDay,
		now.getTime(),
	);
	return { ...metrics, ...recent };
}
