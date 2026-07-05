// Report orchestrator over the fact store. Facts are synced per repo (watermark
// model, see sync.ts), read once, and aggregated at read time into:
//   - calendar-month buckets covering the full requested window THROUGH TODAY
//     (the in-progress month is an extra bucket; charts drop it at render time
//     via completeMonths so they never show a stub bar, while sums, signals and
//     leaderboards keep it so nothing is cut off at a month boundary),
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
	 * on rolling selections (charts drop the partial bucket client-side). */
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
 * Pure: resolve a selection into complete-month buckets and fact-span bounds.
 * The window always ends at the last COMPLETE month (or the explicit `to`), so
 * no bucket is ever the in-progress month; the rolling windows end at today
 * (rolling selection) or at the historical month's end.
 */
export function resolveReportShape(selection: Selection, now: Date): ReportShape {
	const current = monthKeyOf(now);
	const historical = selection.to !== undefined && selection.to < current;
	// Rolling selections bucket the requested N COMPLETE months PLUS the
	// in-progress month as an extra bucket: sums, signals, and leaderboards see
	// data through today, while charts drop the partial bucket at render time
	// (completeMonths), so no surface is cut off and no chart shows a stub bar.
	// An explicit historical `to` is honored as-is (all its months are complete).
	const endKey = historical ? selection.to! : current;
	const extra = historical ? 0 : 1;
	const months = monthsEndingAt(endKey, selection.months + extra);
	const memberMonths = monthsEndingAt(endKey, Math.min(selection.memberMonths, selection.months) + extra);

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
	const { bugLabels } = await getAppSettings();
	const isBug = makeBugMatcher(bugLabels);
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
		const sync = await ensureFactsSynced(
			selection.repos,
			shape.spanStartDay,
			shape.activityStartDay,
			{
				bugLabels,
				now,
			},
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
			`[report] repos=${selection.repos.length} months=${shape.months.length} refreshed=${sync.refreshed}/${sync.synced}`,
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
