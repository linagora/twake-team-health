// Detection layer: turn the metrics/flow/attention data into a list of "what's
// wrong right now" signals, judged against targets. Pure and unit-tested; the
// /signals page just renders the result.
import type { MetricsResult, FlowResult, AttentionResult } from './server/github/types';
import { completeMonths, monthKeyOf, withoutEmptyCurrentMonth } from './months';

export type SignalLevel = 'ok' | 'warn' | 'bad';

/** A signal's recent history: the monthly series (oldest first) for a sparkline,
 * plus whether the latest month is better/worse/flat against the prior baseline.
 * Only attached to signals backed by a per-month metric (the flow checks); the
 * live/aggregate signals (attention, bus-factor, burnout, workload) have none. */
export type SignalTrend = {
	points: number[];
	dir: 'better' | 'worse' | 'flat';
	/** True when the final point is the in-progress month, so the sparkline can
	 * mark a tail that covers days rather than a whole month. */
	partialLast?: boolean;
};

export type Signal = {
	id: string;
	level: SignalLevel;
	title: string;
	value: string;
	target: string;
	detail: string;
	/** Members this signal points at, each rendered as an avatar + link to their profile. */
	people?: { login: string; note: string }[];
	/** Where to dig in: an in-app route this signal drills into (e.g. the attention worklist). */
	link?: { href: string; label: string };
	/** Recent month-over-month direction, when the signal has a monthly series. */
	trend?: SignalTrend;
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
	// Burnout: share of a member's commits made on weekends (Sat/Sun) or late at
	// night (22:00-05:59), measured in the author's own local time.
	weekendWarnPct: number;
	weekendBadPct: number;
	lateNightWarnPct: number;
	lateNightBadPct: number;
	burnoutMinCommits: number; // ignore members with fewer commits than this
	// Workload concentration: the busiest member's share of the team's commits over
	// the window.
	workloadShareWarnPct: number;
	workloadShareBadPct: number;
	minContributors: number; // need at least this many contributors to judge balance
	workloadMinTotal: number; // ignore teams with fewer total commits than this
	// Recovery deficit: the longest run of consecutive weeks a member committed in
	// with no quiet week (no time off) before it's worth flagging.
	recoveryStreakWarnWeeks: number;
	recoveryStreakBadWeeks: number;
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
	stageBadH: 72,
	weekendWarnPct: 25,
	weekendBadPct: 40,
	lateNightWarnPct: 25,
	lateNightBadPct: 40,
	burnoutMinCommits: 15,
	workloadShareWarnPct: 40,
	workloadShareBadPct: 55,
	minContributors: 3,
	workloadMinTotal: 20,
	recoveryStreakWarnWeeks: 8,
	recoveryStreakBadWeeks: 12,
};

/** Stable, order-independent key for a repo SET (FNV-1a, 32-bit hex). Lets a
 * scope's signal history be matched between the snapshot job and the page without
 * depending on team identity: same repos -> same key -> same history. De-duplicates
 * and lowercases so the raw preset list and the request-parsed list (which dedups
 * case-insensitively) hash to the same key. */
export function scopeKey(repos: { owner: string; repo: string }[]): string {
	const norm = [...new Set(repos.map((r) => `${r.owner}/${r.repo}`.toLowerCase()))]
		.sort()
		.join(',');
	let h = 0x811c9dc5;
	for (let i = 0; i < norm.length; i++) {
		h ^= norm.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** Days of daily signal history kept, read, and rendered. Lives here rather than
 * in the server module so the page can lay snapshots over the same fixed window
 * the writer prunes to, without the two drifting apart. */
export const HISTORY_DAYS = 30;

export type HistoryPoint = { day: string; level: SignalLevel; value: string };
/** One slot on the recent-days axis. `point` is absent when no snapshot exists. */
export type HistoryCell = { day: string; point?: HistoryPoint };

/** Lay a signal's snapshots over a fixed recent-days axis, oldest first.
 * Rendering the rows as they come makes a missing day close up rather than leave
 * a hole, so a strip that stopped updating days ago is indistinguishable from a
 * current one. Anchoring to the axis keeps a gap looking like a gap. */
export function historyAxis(
	points: HistoryPoint[],
	days: number = HISTORY_DAYS,
	now: Date = new Date(),
): HistoryCell[] {
	const byDay = new Map(points.map((p) => [p.day, p]));
	const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const out: HistoryCell[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
		const point = byDay.get(day);
		out.push(point ? { day, point } : { day });
	}
	return out;
}

const SEVERITY: Record<SignalLevel, number> = { bad: 0, warn: 1, ok: 2 };

/** Worse as the value climbs (e.g. review latency). */
const highIsBad = (v: number, warn: number, bad: number): SignalLevel =>
	v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok';

/** Worse as the value falls (e.g. review coverage). */
const lowIsBad = (v: number, warn: number, bad: number): SignalLevel =>
	v <= bad ? 'bad' : v <= warn ? 'warn' : 'ok';

const dur = (h: number): string =>
	h >= 48 ? `${Math.round((h / 24) * 10) / 10}d` : `${Math.round(h)}h`;

/** Longest run of consecutive week ids (the set is unique; sorted defensively).
 * 1 for a single isolated active week, 0 for none. */
const longestRun = (weeks: number[]): number => {
	if (!weeks.length) return 0;
	const sorted = [...weeks].sort((a, b) => a - b);
	let best = 1;
	let run = 1;
	for (let i = 1; i < sorted.length; i++) {
		run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
		if (run > best) best = run;
	}
	return best;
};

const median = (xs: number[]): number => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Direction of the latest month against the median of the months before it.
 * `betterWhenLower` is true for metrics where smaller is healthier (latency,
 * cycle time). Changes within 10% of the baseline read as flat (noise). Needs at
 * least two months; returns undefined otherwise so no sparkline is shown.
 *
 * `points` is what the sparkline draws and may end on the in-progress month;
 * `judged` is the complete-month series the direction is read off. They differ
 * because a few days of data is a real point on a line but a meaningless
 * comparison: an empty bucket is zero, which reads as instant reviews on a
 * latency metric and as a collapse on a count. Fewer than two complete months
 * leaves the sparkline with no verdict rather than a verdict on one month. */
function trendOf(
	points: number[],
	betterWhenLower: boolean,
	judged: number[] = points,
	partialLast = false,
): SignalTrend | undefined {
	if (points.length < 2) return undefined;
	if (judged.length < 2) return { points, dir: 'flat', partialLast };
	const last = judged[judged.length - 1];
	const prior = median(judged.slice(0, -1));
	const change = last - prior;
	const rel = prior !== 0 ? Math.abs(change) / prior : last !== 0 ? 1 : 0;
	const dir = rel < 0.1 ? 'flat' : (betterWhenLower ? change < 0 : change > 0) ? 'better' : 'worse';
	return { points, dir, partialLast };
}

/** Compute the full set of signals (including passing ones), most severe first. */
export function computeSignals(
	metrics: MetricsResult | null,
	flow: FlowResult | null,
	attention: AttentionResult | null,
	t: Targets = DEFAULT_TARGETS,
	nowMonthKey: string = monthKeyOf(),
): Signal[] {
	const out: Signal[] = [];

	if (flow && flow.overall.count > 0) {
		// Rolling trailing-30d values when the flow report carries them; otherwise
		// the whole-window medians (no-DB live path / stale cache).
		const o = flow.recent?.current ?? flow.overall;
		const reviewerLoad = flow.recent?.reviewerLoad ?? flow.reviewerLoad;
		const rollingNote = flow.recent ? ' Rolling last 30 days.' : '';
		// All buckets (oldest first), including the in-progress month, so a
		// sparkline ends at today rather than at the last month end. Early in a
		// month that tail point is partial by nature. A month with no merge yet is
		// dropped rather than plotted: computeFlow zero-fills it, and these are
		// medians, so the sparkline would dive to 0 while the arrow beside it
		// (judged on complete months) correctly says flat.
		const allMonths = withoutEmptyCurrentMonth(
			[...flow.byMonth].sort((a, b) => a.month.localeCompare(b.month)),
			(m) => m.count > 0,
			nowMonthKey,
		);
		// Every comparison keeps complete months only: a partial bucket in the
		// median would lower the "typical month" bar and mask a real drop, and as
		// the latest point it would flip the trend arrow on the 1st of the month.
		const complete = completeMonths(allMonths, nowMonthKey);
		// Whether the series ends on the in-progress month, so the sparkline can mark
		// a tail that covers a few days rather than a whole one.
		const partialLast = allMonths[allMonths.length - 1]?.month === nowMonthKey;
		const trend = (
			pick: (m: (typeof allMonths)[number]) => number,
			betterWhenLower: boolean,
		) => trendOf(allMonths.map(pick), betterWhenLower, complete.map(pick), partialLast);
		out.push({
			id: 'first-review',
			level: highIsBad(o.firstReviewHours, t.firstReviewWarnH, t.firstReviewBadH),
			title: 'Time to first review',
			value: dur(o.firstReviewHours),
			target: `under ${t.firstReviewWarnH}h`,
			detail:
				'Median wait from opening a PR to its first review. Long waits stall everyone downstream.' +
				rollingNote,
			trend: trend((m) => m.firstReviewHours, true),
		});
		out.push({
			id: 'cycle-time',
			level: highIsBad(o.mergeHours, t.cycleWarnH, t.cycleBadH),
			title: 'Cycle time',
			value: dur(o.mergeHours),
			target: `under ${dur(t.cycleWarnH)}`,
			detail: 'Median time from opening a PR to merging it.' + rollingNote,
			trend: trend((m) => m.mergeHours, true),
		});
		out.push({
			id: 'review-coverage',
			level: lowIsBad(o.reviewedPct, t.reviewedWarnPct, t.reviewedBadPct),
			title: 'Review coverage',
			value: `${o.reviewedPct}%`,
			target: `at least ${t.reviewedWarnPct}%`,
			detail: 'Share of merged PRs that got at least one review.' + rollingNote,
			trend: trend((m) => m.reviewedPct, false),
		});

		// Bottleneck: which half of the cycle eats the most time. pickup + review
		// (first review -> merge) add up to the cycle, so compare those two.
		// reviewHours is newer than some cached FlowResults; tolerate its absence.
		const stages = [
			{ name: 'waiting for the first review', h: o.firstReviewHours },
			{ name: 'in review (first review to merge)', h: o.reviewHours ?? 0 },
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
			detail: `Most reviewable PR time is spent ${top.name} (${share}% of the tracked stages).`,
			// The slowest stage shrinking is an improvement, so lower is better.
			trend: trend((m) => Math.max(m.firstReviewHours, m.reviewHours ?? 0), true),
		});

		// Throughput anomaly: the trailing 30 days against the median COMPLETE month
		// — both are ~30-day periods, so the comparison is like-for-like while
		// staying current through today (no waiting for the month to close). When
		// the rolling window isn't available (no metrics, e.g. flow-only callers),
		// fall back to the last complete month vs the median of the months before it.
		if (complete.length >= 3) {
			const rolling = metrics?.window30d?.current.merged;
			const last = rolling ?? complete[complete.length - 1].count;
			const baselineMonths = rolling !== undefined ? complete : complete.slice(0, -1);
			const baseline = median(baselineMonths.map((m) => m.count));
			const dropPct = baseline > 0 ? Math.round(((baseline - last) / baseline) * 100) : 0;
			const ranLabel = rolling !== undefined ? 'The last 30 days ran' : 'Last full month was';
			const okLabel = rolling !== undefined ? 'The last 30 days are' : 'Last full month is';
			out.push({
				id: 'throughput-drop',
				level: highIsBad(dropPct, t.throughputDropWarnPct, t.throughputDropBadPct),
				title: 'Merge throughput',
				value: `${last} merged`,
				target: `~${baseline}/month`,
				detail:
					dropPct > 0
						? `${ranLabel} ${dropPct}% below the typical month.`
						: `${okLabel} in line with recent months.`,
				trend: trend((m) => m.count, false),
			});
		}

		// Review-load balance: how much of the reviewing one person carries.
		if (reviewerLoad.length >= t.minReviewers) {
			const total = reviewerLoad.reduce((sum, r) => sum + r.prs, 0);
			const top = reviewerLoad.reduce((a, b) => (b.prs > a.prs ? b : a));
			const pct = total > 0 ? Math.round((top.prs / total) * 100) : 0;
			out.push({
				id: 'review-load',
				level: highIsBad(pct, t.reviewShareWarnPct, t.reviewShareBadPct),
				title: 'Review load balance',
				value: `${pct}%`,
				target: `under ${t.reviewShareWarnPct}%`,
				detail: `Reviewing is concentrated on the busiest of ${reviewerLoad.length} reviewers.`,
				...(pct >= t.reviewShareWarnPct
					? { people: [{ login: top.reviewer, note: `did ${pct}% of reviews` }] }
					: {}),
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
			detail: 'Open PRs that have been around too long.',
			link: { href: '/attention?reason=aging', label: 'View open PRs' },
		});
		out.push({
			id: 'stale-prs',
			level: highIsBad(s.stale, t.staleWarn, t.staleBad),
			title: 'Stalled open PRs',
			value: `${s.stale}`,
			target: `under ${t.staleWarn}`,
			detail: 'Open PRs with no recent activity.',
			link: { href: '/attention?reason=stale', label: 'View open PRs' },
		});
		out.push({
			id: 'unreviewed-prs',
			level: highIsBad(s.unreviewed, t.unreviewedWarn, t.unreviewedBad),
			title: 'Unreviewed open PRs',
			value: `${s.unreviewed}`,
			target: `under ${t.unreviewedWarn}`,
			detail: 'Open PRs still waiting for a first review.',
			link: { href: '/attention?reason=unreviewed', label: 'View open PRs' },
		});
	}

	// Knowledge concentration (bus factor): repos where one person wrote most of
	// the commits are a resignation/absence risk.
	if (metrics && metrics.commitsByAuthorRepo.length) {
		const byRepo = new Map<string, { total: number; top: number; topAuthor: string }>();
		for (const c of metrics.commitsByAuthorRepo) {
			const e = byRepo.get(c.repo) ?? { total: 0, top: 0, topAuthor: '' };
			e.total += c.commits;
			if (c.commits > e.top) {
				e.top = c.commits; // one row per (author, repo)
				e.topAuthor = c.author;
			}
			byRepo.set(c.repo, e);
		}
		const concentratedList: { login: string; note: string; pct: number }[] = [];
		for (const [repo, e] of byRepo) {
			if (e.total < t.busMinCommits) continue;
			const pct = Math.round((e.top / e.total) * 100);
			if (pct >= t.busShareWarnPct && e.topAuthor) {
				concentratedList.push({
					login: e.topAuthor,
					note: `wrote ${pct}% of the team's commits to ${repo}`,
					pct,
				});
			}
		}
		concentratedList.sort((a, b) => b.pct - a.pct);
		const concentrated = concentratedList.length;
		out.push({
			id: 'bus-factor',
			level: highIsBad(concentrated, t.concentratedWarn, t.concentratedBad),
			title: 'Knowledge concentration',
			value: `${concentrated} repos`,
			target: `under ${t.concentratedWarn}`,
			detail: concentrated
				? `${concentrated} ${concentrated === 1 ? 'repository depends' : 'repositories depend'} on a single maintainer.`
				: 'No single-maintainer repositories detected.',
			...(concentrated
				? { people: concentratedList.map(({ login, note }) => ({ login, note })) }
				: {}),
		});
	}

	// Burnout risk: members doing an outsized share of their commits on weekends or
	// late at night, judged in the author's own local time (so a 2am commit counts
	// against the committer wherever they are, not against the server's clock).
	if (metrics && metrics.workPattern?.length) {
		// Burnout is a "right now" pattern -> rolling trailing-30d when available.
		// Recovery deficit needs many weeks (an 8-week streak can't fit in 30 days),
		// so it stays on the longer window below.
		const burnoutWp = metrics.recentWorkPattern?.length
			? metrics.recentWorkPattern
			: metrics.workPattern;
		const flagged: { login: string; note: string; level: SignalLevel }[] = [];
		for (const w of burnoutWp) {
			if (w.commits < t.burnoutMinCommits) continue;
			const wkPct = Math.round((w.weekendCommits / w.commits) * 100);
			const lnPct = Math.round((w.lateNightCommits / w.commits) * 100);
			const wkLevel = highIsBad(wkPct, t.weekendWarnPct, t.weekendBadPct);
			const lnLevel = highIsBad(lnPct, t.lateNightWarnPct, t.lateNightBadPct);
			const level = SEVERITY[wkLevel] < SEVERITY[lnLevel] ? wkLevel : lnLevel;
			if (level === 'ok') continue;
			const parts: string[] = [];
			if (wkLevel !== 'ok') parts.push(`${wkPct}% on weekends`);
			if (lnLevel !== 'ok') parts.push(`${lnPct}% late at night`);
			flagged.push({
				login: w.author,
				note: `${parts.join(', ')} (of ${w.commits} commits)`,
				level,
			});
		}
		// Sorted most-severe first, so the worst person's level is the signal's level.
		flagged.sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
		out.push({
			id: 'burnout',
			level: flagged[0]?.level ?? 'ok',
			title: 'Burnout risk',
			value: `${flagged.length} ${flagged.length === 1 ? 'person' : 'people'}`,
			target: 'none',
			detail: flagged.length
				? `${flagged.length === 1 ? 'Someone is' : `${flagged.length} people are`} committing heavily on weekends or late at night.`
				: 'No outsized weekend or late-night commit patterns.',
			...(flagged.length ? { people: flagged.map(({ login, note }) => ({ login, note })) } : {}),
		});

		// Recovery deficit: members who committed week after week with no quiet week.
		// The longest unbroken run of active weeks is the measure — a real break (a
		// week with zero commits) resets it, which is exactly what we want to catch.
		const noBreak: { login: string; note: string; level: SignalLevel }[] = [];
		for (const w of metrics.workPattern) {
			const streak = longestRun(w.activeWeeks ?? []);
			const level = highIsBad(streak, t.recoveryStreakWarnWeeks, t.recoveryStreakBadWeeks);
			if (level === 'ok') continue;
			noBreak.push({ login: w.author, note: `${streak} weeks with no break`, level });
		}
		noBreak.sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
		out.push({
			id: 'recovery',
			level: noBreak[0]?.level ?? 'ok',
			title: 'Recovery deficit',
			value: `${noBreak.length} ${noBreak.length === 1 ? 'person' : 'people'}`,
			target: 'none',
			detail: noBreak.length
				? `${noBreak.length === 1 ? 'Someone has' : `${noBreak.length} people have`} committed week after week with no break.`
				: 'No long unbroken commit streaks.',
			...(noBreak.length ? { people: noBreak.map(({ login, note }) => ({ login, note })) } : {}),
		});
	}

	// Workload concentration: how much of the team's commits over the window land on
	// one person. The volume counterpart to the burnout timing signal — one person
	// carrying the team is an overload (and bus-factor) risk. Commits are the unit
	// (a single, comparable measure); mixing in merged-PR counts would double-count,
	// since a merged PR's own commits are already in this tally.
	if (metrics && (metrics.recentMembers?.length || metrics.authors.length)) {
		// Rolling trailing-30d commit share when available; else the window sums.
		const commits = new Map<string, number>();
		if (metrics.recentMembers?.length) {
			for (const m of metrics.recentMembers) if (m.commits > 0) commits.set(m.login, m.commits);
		} else {
			for (const a of metrics.authors)
				commits.set(a.author, (commits.get(a.author) ?? 0) + a.commits);
		}
		const total = [...commits.values()].reduce((s, n) => s + n, 0);
		if (commits.size >= t.minContributors && total >= t.workloadMinTotal) {
			const [topAuthor, topCommits] = [...commits].reduce((a, b) => (b[1] > a[1] ? b : a));
			const pct = Math.round((topCommits / total) * 100);
			out.push({
				id: 'workload',
				level: highIsBad(pct, t.workloadShareWarnPct, t.workloadShareBadPct),
				title: 'Workload concentration',
				value: `${pct}%`,
				target: `under ${t.workloadShareWarnPct}%`,
				detail: `Commits are concentrated on the busiest of ${commits.size} contributors.`,
				...(pct >= t.workloadShareWarnPct
					? { people: [{ login: topAuthor, note: `wrote ${pct}% of the team's commits` }] }
					: {}),
			});
		}
	}

	return out.sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
}
