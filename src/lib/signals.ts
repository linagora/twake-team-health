// Detection layer: turn the metrics/flow/attention data into a list of "what's
// wrong right now" signals, judged against targets. Pure and unit-tested; the
// /signals page just renders the result.
import type { MetricsResult, FlowResult, AttentionResult } from './server/github/types';
import { monthKeyOf } from './months';

export type SignalLevel = 'ok' | 'warn' | 'bad';

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
	workloadMinTotal: 20
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
	t: Targets = DEFAULT_TARGETS,
	nowMonthKey: string = monthKeyOf()
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

		// Bottleneck: which half of the cycle eats the most time. pickup + review
		// (first review -> merge) add up to the cycle, so compare those two.
		// reviewHours is newer than some cached FlowResults; tolerate its absence.
		const stages = [
			{ name: 'waiting for the first review', h: o.firstReviewHours },
			{ name: 'in review (first review to merge)', h: o.reviewHours ?? 0 }
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
		// before it. Exclude only the current (partial) calendar month — for a
		// historical window the final month is complete and must be kept.
		const complete = flow.byMonth.filter((m) => m.month < nowMonthKey);
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
			const top = flow.reviewerLoad.reduce((a, b) => (b.prs > a.prs ? b : a));
			const pct = total > 0 ? Math.round((top.prs / total) * 100) : 0;
			out.push({
				id: 'review-load',
				level: highIsBad(pct, t.reviewShareWarnPct, t.reviewShareBadPct),
				title: 'Review load balance',
				value: `${pct}%`,
				target: `under ${t.reviewShareWarnPct}%`,
				detail: `Reviewing is concentrated on the busiest of ${flow.reviewerLoad.length} reviewers.`,
				...(pct >= t.reviewShareWarnPct
					? { people: [{ login: top.reviewer, note: `did ${pct}% of reviews` }] }
					: {})
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
			link: { href: '/attention?reason=aging', label: 'View open PRs' }
		});
		out.push({
			id: 'stale-prs',
			level: highIsBad(s.stale, t.staleWarn, t.staleBad),
			title: 'Stalled open PRs',
			value: `${s.stale}`,
			target: `under ${t.staleWarn}`,
			detail: 'Open PRs with no recent activity.',
			link: { href: '/attention?reason=stale', label: 'View open PRs' }
		});
		out.push({
			id: 'unreviewed-prs',
			level: highIsBad(s.unreviewed, t.unreviewedWarn, t.unreviewedBad),
			title: 'Unreviewed open PRs',
			value: `${s.unreviewed}`,
			target: `under ${t.unreviewedWarn}`,
			detail: 'Open PRs still waiting for a first review.',
			link: { href: '/attention?reason=unreviewed', label: 'View open PRs' }
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
				concentratedList.push({ login: e.topAuthor, note: `wrote ${pct}% of the team's commits to ${repo}`, pct });
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
			...(concentrated ? { people: concentratedList.map(({ login, note }) => ({ login, note })) } : {})
		});
	}

	// Burnout risk: members doing an outsized share of their commits on weekends or
	// late at night, judged in the author's own local time (so a 2am commit counts
	// against the committer wherever they are, not against the server's clock).
	if (metrics && metrics.workPattern?.length) {
		const flagged: { login: string; note: string; level: SignalLevel }[] = [];
		for (const w of metrics.workPattern) {
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
			flagged.push({ login: w.author, note: `${parts.join(', ')} (of ${w.commits} commits)`, level });
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
			...(flagged.length ? { people: flagged.map(({ login, note }) => ({ login, note })) } : {})
		});
	}

	// Workload concentration: how much of the team's commits over the window land on
	// one person. The volume counterpart to the burnout timing signal — one person
	// carrying the team is an overload (and bus-factor) risk. Commits are the unit
	// (a single, comparable measure); mixing in merged-PR counts would double-count,
	// since a merged PR's own commits are already in this tally.
	if (metrics && metrics.authors.length) {
		const commits = new Map<string, number>();
		for (const a of metrics.authors) commits.set(a.author, (commits.get(a.author) ?? 0) + a.commits);
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
					: {})
			});
		}
	}

	return out.sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
}
