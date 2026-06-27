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
	// People health: knowledge concentration (bus factor) and review-load balance.
	busShareWarnPct: number; // a repo's top committer share that counts as concentrated
	busMinCommits: number; // ignore repos with fewer commits than this
	concentratedWarn: number; // how many concentrated repos before it's a problem
	concentratedBad: number;
	reviewShareWarnPct: number; // busiest reviewer's share of all reviews
	reviewShareBadPct: number;
	minReviewers: number; // need at least this many to judge balance
	stageWarnH: number; // a single PR-lifecycle stage this slow is worth flagging
	stageBadH: number;
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
	throughputDropBadPct: 50,
	busShareWarnPct: 70,
	busMinCommits: 20,
	concentratedWarn: 2,
	concentratedBad: 4,
	reviewShareWarnPct: 50,
	reviewShareBadPct: 70,
	minReviewers: 3,
	stageWarnH: 24,
	stageBadH: 72
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

		// Bottleneck: which PR-lifecycle stage eats the most time, so a slow cycle
		// can be localized instead of just observed.
		// reviewHours is newer than some cached FlowResults; tolerate its absence.
		const stages = [
			{ name: 'waiting for first review', h: o.firstReviewHours },
			{ name: 'in review (first review to approval)', h: o.reviewHours ?? 0 },
			{ name: 'waiting to merge after approval', h: o.postApproveHours }
		];
		const top = stages.reduce((a, b) => (b.h > a.h ? b : a));
		const sum = stages.reduce((s, x) => s + x.h, 0);
		const share = sum > 0 ? Math.round((top.h / sum) * 100) : 0;
		out.push({
			id: 'bottleneck',
			level: highIsBad(top.h, t.stageWarnH, t.stageBadH),
			title: 'Slowest PR stage',
			value: dur(top.h),
			target: `under ${dur(t.stageWarnH)}`,
			detail: `Most reviewable PR time is spent ${top.name} (${share}% of the tracked stages).`
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

		// Review-load balance: how much of the reviewing one person carries.
		if (flow.reviewerLoad.length >= t.minReviewers) {
			const total = flow.reviewerLoad.reduce((sum, r) => sum + r.prs, 0);
			const top = Math.max(...flow.reviewerLoad.map((r) => r.prs));
			const pct = total > 0 ? Math.round((top / total) * 100) : 0;
			out.push({
				id: 'review-load',
				level: highIsBad(pct, t.reviewShareWarnPct, t.reviewShareBadPct),
				title: 'Review load balance',
				value: `${pct}%`,
				target: `under ${t.reviewShareWarnPct}%`,
				detail: `Share of all PR reviews carried by the busiest of ${flow.reviewerLoad.length} reviewers.`
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

	// Knowledge concentration (bus factor): repos where one person wrote most of
	// the commits are a resignation/absence risk.
	if (metrics && metrics.commitsByAuthorRepo.length) {
		const byRepo = new Map<string, { total: number; top: number }>();
		for (const c of metrics.commitsByAuthorRepo) {
			const e = byRepo.get(c.repo) ?? { total: 0, top: 0 };
			e.total += c.commits;
			e.top = Math.max(e.top, c.commits); // one row per (author, repo)
			byRepo.set(c.repo, e);
		}
		let concentrated = 0;
		let worst = { repo: '', pct: 0 };
		for (const [repo, e] of byRepo) {
			if (e.total < t.busMinCommits) continue;
			const pct = Math.round((e.top / e.total) * 100);
			if (pct >= t.busShareWarnPct) concentrated += 1;
			if (pct > worst.pct) worst = { repo, pct };
		}
		out.push({
			id: 'bus-factor',
			level: highIsBad(concentrated, t.concentratedWarn, t.concentratedBad),
			title: 'Knowledge concentration',
			value: `${concentrated} repos`,
			target: `under ${t.concentratedWarn}`,
			detail: concentrated
				? `${concentrated} repositories where one person wrote ≥${t.busShareWarnPct}% of commits (worst: ${worst.repo} at ${worst.pct}%).`
				: 'No single-maintainer repositories detected.'
		});
	}

	return out.sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
}
