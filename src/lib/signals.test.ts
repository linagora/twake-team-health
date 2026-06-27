import { describe, it, expect } from 'vitest';
import { computeSignals, DEFAULT_TARGETS } from './signals';
import type { FlowResult, AttentionResult, FlowStats } from './server/github/types';

const stats = (o: Partial<FlowStats>): FlowStats => ({
	count: 10,
	reviewedPct: 100,
	firstReviewHours: 2,
	mergeHours: 10,
	postApproveHours: 1,
	...o
});

const flowWith = (overall: Partial<FlowStats>, monthCounts: number[] = []): FlowResult => ({
	overall: stats(overall),
	byMonth: monthCounts.map((count, i) => ({ month: `2026-0${i + 1}`, ...stats({ count }) })),
	reviewerLoad: [],
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
		const sig = computeSignals(null, flowWith({}, [10, 10, 2, 1]), null);
		expect(find(sig, 'throughput-drop')?.level).toBe('bad');
	});

	it('does not flag steady throughput', () => {
		const sig = computeSignals(null, flowWith({}, [10, 10, 10, 4]), null);
		expect(find(sig, 'throughput-drop')?.level).toBe('ok');
	});

	it('flags aging/stale/unreviewed PRs from the attention summary', () => {
		const sig = computeSignals(null, null, attentionWith({ aging: 9, stale: 0, unreviewed: 5 }));
		expect(find(sig, 'aging-prs')?.level).toBe('bad');
		expect(find(sig, 'stale-prs')?.level).toBe('ok');
		expect(find(sig, 'unreviewed-prs')?.level).toBe('warn');
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
