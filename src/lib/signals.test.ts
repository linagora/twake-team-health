import { describe, it, expect } from 'vitest';
import { computeSignals, DEFAULT_TARGETS } from './signals';
import type {
	FlowResult,
	AttentionResult,
	FlowStats,
	MetricsResult,
	AuthorRepoCommits,
	WorkPattern
} from './server/github/types';

const metricsWith = (
	commitsByAuthorRepo: AuthorRepoCommits[],
	workPattern: WorkPattern[] = [],
	authors: MetricsResult['authors'] = [],
	mergedByAuthor: MetricsResult['mergedByAuthor'] = []
): MetricsResult => ({
	repos: [],
	authors,
	mergedByAuthor,
	reviewActivity: [],
	issuesByMonth: [],
	commitsByAuthorRepo,
	linesByAuthor: [],
	workPattern,
	generatedAt: 0
});

const stats = (o: Partial<FlowStats>): FlowStats => ({
	count: 10,
	reviewedPct: 100,
	firstReviewHours: 2,
	reviewHours: 2,
	mergeHours: 10,
	postApproveHours: 1,
	...o
});

const flowWith = (overall: Partial<FlowStats>, monthCounts: number[] = []): FlowResult => ({
	overall: stats(overall),
	byMonth: monthCounts.map((count, i) => ({ month: `2026-0${i + 1}`, ...stats({ count }) })),
	reviewerLoad: [],
	botActivity: [],
	botByMonth: [],
	generatedAt: 0
});

const attentionWith = (s: Partial<AttentionResult['summary']>): AttentionResult => ({
	items: [],
	summary: { total: 0, unreviewed: 0, changes_requested: 0, stale: 0, aging: 0, draft_stale: 0, ...s },
	generatedAt: 0
});

const find = (sig: ReturnType<typeof computeSignals>, id: string) => sig.find((s) => s.id === id);

describe('computeSignals', () => {
	it('flags slow first review and slow cycle time as bad', () => {
		const sig = computeSignals(null, flowWith({ firstReviewHours: 30, mergeHours: 120 }), null);
		expect(find(sig, 'first-review')?.level).toBe('bad');
		expect(find(sig, 'cycle-time')?.level).toBe('bad');
	});

	it('passes healthy flow numbers', () => {
		const sig = computeSignals(null, flowWith({ firstReviewHours: 3, mergeHours: 20, reviewedPct: 95 }), null);
		expect(find(sig, 'first-review')?.level).toBe('ok');
		expect(find(sig, 'review-coverage')?.level).toBe('ok');
	});

	it('flags low review coverage', () => {
		expect(find(computeSignals(null, flowWith({ reviewedPct: 40 }), null), 'review-coverage')?.level).toBe('bad');
		expect(find(computeSignals(null, flowWith({ reviewedPct: 70 }), null), 'review-coverage')?.level).toBe('warn');
	});

	it('emits no flow signals when there are no merged PRs', () => {
		const sig = computeSignals(null, flowWith({ count: 0 }), null);
		expect(find(sig, 'first-review')).toBeUndefined();
	});

	it('detects a throughput drop against the recent median, ignoring the partial current month', () => {
		// completed months [10,10,2] (last entry is the in-progress month, dropped):
		// last full = 2, baseline = median(10,10) = 10 -> 80% drop.
		// nowMonthKey 2026-04 => the 4th month is the current partial one, excluded.
		const sig = computeSignals(null, flowWith({}, [10, 10, 2, 1]), null, DEFAULT_TARGETS, '2026-04');
		expect(find(sig, 'throughput-drop')?.level).toBe('bad');
	});

	it('does not flag steady throughput', () => {
		const sig = computeSignals(null, flowWith({}, [10, 10, 10, 4]), null, DEFAULT_TARGETS, '2026-04');
		expect(find(sig, 'throughput-drop')?.level).toBe('ok');
	});

	it('keeps the final month for a historical window (now is later)', () => {
		// months 2026-01..04 are all complete because now is 2026-06; the drop in the
		// last month must be detected, not silently dropped as "partial".
		const sig = computeSignals(null, flowWith({}, [10, 10, 10, 2]), null, DEFAULT_TARGETS, '2026-06');
		expect(find(sig, 'throughput-drop')?.value).toBe('2 merged');
		expect(find(sig, 'throughput-drop')?.level).toBe('bad');
	});

	it('flags aging/stale/unreviewed PRs from the attention summary', () => {
		const sig = computeSignals(null, null, attentionWith({ aging: 9, stale: 0, unreviewed: 5 }));
		expect(find(sig, 'aging-prs')?.level).toBe('bad');
		expect(find(sig, 'stale-prs')?.level).toBe('ok');
		expect(find(sig, 'unreviewed-prs')?.level).toBe('warn');
	});

	it('identifies the slowest PR stage as the bottleneck', () => {
		const sig = computeSignals(
			null,
			flowWith({ firstReviewHours: 4, reviewHours: 80, postApproveHours: 2 }),
			null
		);
		const b = find(sig, 'bottleneck');
		expect(b?.level).toBe('bad'); // 80h review stage > stageBadH
		expect(b?.detail).toContain('in review');
	});

	it('flags review-load imbalance when one reviewer dominates', () => {
		const flow = flowWith({});
		flow.reviewerLoad = [
			{ reviewer: 'a', prs: 80 },
			{ reviewer: 'b', prs: 10 },
			{ reviewer: 'c', prs: 10 }
		];
		expect(find(computeSignals(null, flow, null), 'review-load')?.level).toBe('bad');
	});

	it('does not judge review balance with too few reviewers', () => {
		const flow = flowWith({});
		flow.reviewerLoad = [{ reviewer: 'a', prs: 50 }];
		expect(find(computeSignals(null, flow, null), 'review-load')).toBeUndefined();
	});

	it('flags knowledge concentration but ignores low-commit repos', () => {
		const m = metricsWith([
			{ author: 'solo', repo: 'o/a', commits: 95 }, // 100% of 95 -> concentrated
			{ author: 'x', repo: 'o/a', commits: 0 },
			{ author: 'p', repo: 'o/b', commits: 3 }, // below busMinCommits -> ignored
			{ author: 'q', repo: 'o/b', commits: 2 }
		]);
		const sig = find(computeSignals(m, null, null), 'bus-factor');
		expect(sig?.value).toBe('1 repos');
		expect(sig?.people?.[0]?.login).toBe('solo');
		expect(sig?.people?.[0]?.note).toContain('o/a');
	});

	it('passes when commits are well spread', () => {
		const m = metricsWith([
			{ author: 'a', repo: 'o/a', commits: 30 },
			{ author: 'b', repo: 'o/a', commits: 30 },
			{ author: 'c', repo: 'o/a', commits: 30 }
		]);
		expect(find(computeSignals(m, null, null), 'bus-factor')?.level).toBe('ok');
	});

	it('flags burnout for heavy weekend / late-night committers, ignoring low-volume members', () => {
		const m = metricsWith(
			[],
			[
				{ author: 'weekendwarrior', commits: 40, weekendCommits: 20, lateNightCommits: 0, activeWeeks: [] }, // 50% weekend -> bad
				{ author: 'nightowl', commits: 40, weekendCommits: 0, lateNightCommits: 12, activeWeeks: [] }, // 30% late -> warn
				{ author: 'balanced', commits: 40, weekendCommits: 2, lateNightCommits: 2, activeWeeks: [] }, // 5% each -> ok
				{ author: 'newbie', commits: 4, weekendCommits: 4, lateNightCommits: 4, activeWeeks: [] } // below burnoutMinCommits -> ignored
			]
		);
		const sig = find(computeSignals(m, null, null), 'burnout');
		expect(sig?.level).toBe('bad');
		expect(sig?.value).toBe('2 people');
		const logins = sig?.people?.map((p) => p.login) ?? [];
		expect(logins).toContain('weekendwarrior');
		expect(logins).toContain('nightowl');
		expect(logins).not.toContain('balanced');
		expect(logins).not.toContain('newbie');
	});

	it('passes burnout when commit timing is well spread', () => {
		const m = metricsWith([], [{ author: 'steady', commits: 50, weekendCommits: 3, lateNightCommits: 3, activeWeeks: [] }]);
		expect(find(computeSignals(m, null, null), 'burnout')?.level).toBe('ok');
	});

	it('flags a recovery deficit for a long unbroken active-week streak, reset by a quiet week', () => {
		const m = metricsWith(
			[],
			[
				// 13 consecutive weeks, no break -> bad (>= recoveryStreakBadWeeks 12).
				{ author: 'machine', commits: 50, weekendCommits: 0, lateNightCommits: 0, activeWeeks: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112] },
				// A break at week 205 caps the longest run at 4 -> ok.
				{ author: 'rests', commits: 50, weekendCommits: 0, lateNightCommits: 0, activeWeeks: [200, 201, 202, 203, 205, 206] }
			]
		);
		const sig = find(computeSignals(m, null, null), 'recovery');
		expect(sig?.level).toBe('bad');
		expect(sig?.value).toBe('1 person');
		expect(sig?.people?.[0]?.login).toBe('machine');
		expect(sig?.people?.[0]?.note).toContain('13 weeks');
	});

	it('passes recovery when everyone takes breaks', () => {
		const m = metricsWith(
			[],
			[{ author: 'rests', commits: 50, weekendCommits: 0, lateNightCommits: 0, activeWeeks: [1, 2, 3, 6, 7, 8] }]
		);
		expect(find(computeSignals(m, null, null), 'recovery')?.level).toBe('ok');
	});

	it('flags workload concentration when one contributor dominates commits', () => {
		const m = metricsWith(
			[],
			[],
			[
				{ author: 'lead', month: '2026-06', commits: 60 },
				{ author: 'b', month: '2026-06', commits: 5 },
				{ author: 'c', month: '2026-06', commits: 5 }
			]
		);
		const sig = find(computeSignals(m, null, null), 'workload');
		// lead = 60 of 70 commits -> 86% -> bad.
		expect(sig?.level).toBe('bad');
		expect(sig?.value).toBe('86%');
		expect(sig?.people?.[0]?.login).toBe('lead');
	});

	it('warns (with the person named) when one contributor is in the warn band', () => {
		const m = metricsWith(
			[],
			[],
			[
				{ author: 'a', month: '2026-06', commits: 45 },
				{ author: 'b', month: '2026-06', commits: 30 },
				{ author: 'c', month: '2026-06', commits: 25 }
			]
		);
		const sig = find(computeSignals(m, null, null), 'workload');
		expect(sig?.level).toBe('warn'); // 45% is in [40, 55)
		expect(sig?.people?.[0]?.login).toBe('a');
	});

	it('does not judge workload with too few contributors', () => {
		const m = metricsWith([], [], [{ author: 'solo', month: '2026-06', commits: 99 }]);
		expect(find(computeSignals(m, null, null), 'workload')).toBeUndefined();
	});

	it('does not judge workload below the minimum total commits', () => {
		const m = metricsWith(
			[],
			[],
			[
				{ author: 'a', month: '2026-06', commits: 6 },
				{ author: 'b', month: '2026-06', commits: 5 },
				{ author: 'c', month: '2026-06', commits: 5 }
			]
		);
		// total 16 < workloadMinTotal (20) -> not enough work to judge.
		expect(find(computeSignals(m, null, null), 'workload')).toBeUndefined();
	});

	it('passes workload when commits are well spread', () => {
		const m = metricsWith(
			[],
			[],
			[
				{ author: 'a', month: '2026-06', commits: 20 },
				{ author: 'b', month: '2026-06', commits: 20 },
				{ author: 'c', month: '2026-06', commits: 20 }
			]
		);
		expect(find(computeSignals(m, null, null), 'workload')?.level).toBe('ok');
	});

	it('attaches an improving trend when a latency metric falls vs its baseline', () => {
		// firstReviewHours per month [20,20,20,4]; now=2026-06 keeps all 4 as complete.
		// last 4 vs median(20,20,20)=20 -> big drop -> "better" (lower is better).
		const flow = flowWith({ firstReviewHours: 4 }, [10, 10, 10, 10]);
		flow.byMonth = flow.byMonth.map((m, i) => ({ ...m, firstReviewHours: [20, 20, 20, 4][i] }));
		const sig = find(computeSignals(null, flow, null, DEFAULT_TARGETS, '2026-06'), 'first-review');
		expect(sig?.trend?.dir).toBe('better');
		expect(sig?.trend?.points).toEqual([20, 20, 20, 4]);
	});

	it('marks a worsening trend when review coverage falls', () => {
		const flow = flowWith({ reviewedPct: 50 }, [10, 10, 10, 10]);
		flow.byMonth = flow.byMonth.map((m, i) => ({ ...m, reviewedPct: [95, 95, 95, 50][i] }));
		const sig = find(computeSignals(null, flow, null, DEFAULT_TARGETS, '2026-06'), 'review-coverage');
		expect(sig?.trend?.dir).toBe('worse'); // coverage dropping is bad (higher is better)
	});

	it('attaches a trend to the bottleneck stage from the slowest stage per month', () => {
		const flow = flowWith({ firstReviewHours: 4, reviewHours: 20 }, [10, 10, 10]);
		flow.byMonth = flow.byMonth.map((m, i) => ({ ...m, firstReviewHours: 4, reviewHours: [80, 80, 20][i] }));
		const sig = find(computeSignals(null, flow, null, DEFAULT_TARGETS, '2026-06'), 'bottleneck');
		expect(sig?.trend?.points).toEqual([80, 80, 20]); // max(4, reviewHours) per month
		expect(sig?.trend?.dir).toBe('better'); // the slowest stage shrinking is good
	});

	it('omits the trend when there is only one complete month', () => {
		const flow = flowWith({}, [10, 5]); // months 2026-01, 2026-02
		const sig = find(computeSignals(null, flow, null, DEFAULT_TARGETS, '2026-02'), 'first-review');
		expect(sig?.trend).toBeUndefined(); // only 2026-01 is complete -> < 2 points
	});

	it('orders most severe first', () => {
		const sig = computeSignals(
			null,
			flowWith({ firstReviewHours: 30, reviewedPct: 100 }),
			attentionWith({})
		);
		expect(sig[0].level).toBe('bad');
		expect(sig[sig.length - 1].level).toBe('ok');
	});
});
