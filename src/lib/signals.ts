// Detection layer: turn the metrics/flow/attention data into a list of "what's
// wrong right now" signals, judged against targets. Pure and unit-tested; the
// /signals page just renders the result.
import type { MetricsResult, FlowResult, AttentionResult } from './server/github/types';

export type SignalLevel = 'ok' | 'warn' | 'bad';

export type Signal = {
	id: string;
	level: SignalLevel;
	title: string;
	value: string;
	target: string;
	detail: string;
};

export type Targets = {
	firstReviewWarnH: number;
	firstReviewBadH: number;
	cycleWarnH: number;
	cycleBadH: number;
	reviewedWarnPct: number;
	reviewedBadPct: number;
	agingWarn: number;
	agingBad: number;
	staleWarn: number;
	staleBad: number;
	unreviewedWarn: number;
	unreviewedBad: number;
	throughputDropWarnPct: number;
	throughputDropBadPct: number;
};

export const DEFAULT_TARGETS: Targets = {
	firstReviewWarnH: 8,
	firstReviewBadH: 24,
	cycleWarnH: 48,
	cycleBadH: 96,
	reviewedWarnPct: 80,
	reviewedBadPct: 50,
	agingWarn: 3,
	agingBad: 8,
	staleWarn: 3,
	staleBad: 8,
	unreviewedWarn: 4,
	unreviewedBad: 10,
	throughputDropWarnPct: 30,
	throughputDropBadPct: 50
};

const SEVERITY: Record<SignalLevel, number> = { bad: 0, warn: 1, ok: 2 };

/** Worse as the value climbs (e.g. review latency). */
const highIsBad = (v: number, warn: number, bad: number): SignalLevel =>
	v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok';

/** Worse as the value falls (e.g. review coverage). */
const lowIsBad = (v: number, warn: number, bad: number): SignalLevel =>
	v <= bad ? 'bad' : v <= warn ? 'warn' : 'ok';

const dur = (h: number): string => (h >= 48 ? `${Math.round((h / 24) * 10) / 10}d` : `${Math.round(h)}h`);

const median = (xs: number[]): number => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Compute the full set of signals (including passing ones), most severe first. */
export function computeSignals(
	metrics: MetricsResult | null,
	flow: FlowResult | null,
	attention: AttentionResult | null,
	t: Targets = DEFAULT_TARGETS
): Signal[] {
	const out: Signal[] = [];

	if (flow && flow.overall.count > 0) {
		const o = flow.overall;
		out.push({
			id: 'first-review',
			level: highIsBad(o.firstReviewHours, t.firstReviewWarnH, t.firstReviewBadH),
			title: 'Time to first review',
			value: dur(o.firstReviewHours),
			target: `under ${t.firstReviewWarnH}h`,
			detail: 'Median wait from opening a PR to its first review. Long waits stall everyone downstream.'
		});
		out.push({
			id: 'cycle-time',
			level: highIsBad(o.mergeHours, t.cycleWarnH, t.cycleBadH),
			title: 'Cycle time',
			value: dur(o.mergeHours),
			target: `under ${dur(t.cycleWarnH)}`,
			detail: 'Median time from opening a PR to merging it.'
		});
		out.push({
			id: 'review-coverage',
			level: lowIsBad(o.reviewedPct, t.reviewedWarnPct, t.reviewedBadPct),
			title: 'Review coverage',
			value: `${o.reviewedPct}%`,
			target: `at least ${t.reviewedWarnPct}%`,
			detail: 'Share of merged PRs that got at least one review.'
		});

		// Throughput anomaly: the last completed month vs the median of the months
		// before it. The current (in-progress) month is partial, so it is excluded.
		const complete = flow.byMonth.slice(0, -1);
		if (complete.length >= 3) {
			const last = complete[complete.length - 1].count;
			const baseline = median(complete.slice(0, -1).map((m) => m.count));
			const dropPct = baseline > 0 ? Math.round(((baseline - last) / baseline) * 100) : 0;
			out.push({
				id: 'throughput-drop',
				level: highIsBad(dropPct, t.throughputDropWarnPct, t.throughputDropBadPct),
				title: 'Merge throughput',
				value: `${last} merged`,
				target: `~${baseline} typical`,
				detail:
					dropPct > 0
						? `Last full month was ${dropPct}% below the recent median.`
						: 'Last full month is in line with recent months.'
			});
		}
	}

	if (attention) {
		const s = attention.summary;
		out.push({
			id: 'aging-prs',
			level: highIsBad(s.aging, t.agingWarn, t.agingBad),
			title: 'Aging open PRs',
			value: `${s.aging}`,
			target: `under ${t.agingWarn}`,
			detail: 'Open PRs that have been around too long.'
		});
		out.push({
			id: 'stale-prs',
			level: highIsBad(s.stale, t.staleWarn, t.staleBad),
			title: 'Stalled open PRs',
			value: `${s.stale}`,
			target: `under ${t.staleWarn}`,
			detail: 'Open PRs with no recent activity.'
		});
		out.push({
			id: 'unreviewed-prs',
			level: highIsBad(s.unreviewed, t.unreviewedWarn, t.unreviewedBad),
			title: 'Unreviewed open PRs',
			value: `${s.unreviewed}`,
			target: `under ${t.unreviewedWarn}`,
			detail: 'Open PRs still waiting for a first review.'
		});
	}

	return out.sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
}
