import { describe, it, expect } from 'vitest';
import { computeFlow } from './flow';
import type { PrFlow } from './github/types';

const NOW = Date.parse('2026-06-26T00:00:00Z');
const BASE = '2026-06-10T00:00:00Z';
const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.parse(BASE) + hours * HOUR).toISOString();

const prs: PrFlow[] = [
	{ repo: 'o/r', month: '2026-06', createdAt: BASE, mergedAt: at(24), firstReviewAt: at(2), approvedAt: at(20), reviewers: ['alice', 'bob'] },
	{ repo: 'o/r', month: '2026-06', createdAt: BASE, mergedAt: at(10), firstReviewAt: null, approvedAt: null, reviewers: [] },
	{ repo: 'o/r', month: '2026-06', createdAt: BASE, mergedAt: at(36), firstReviewAt: at(6), approvedAt: at(30), reviewers: ['alice'] }
];

describe('computeFlow', () => {
	const r = computeFlow(prs, ['2026-06'], NOW);

	it('medians each cycle-time stage and review coverage', () => {
		expect(r.overall.count).toBe(3);
		expect(r.overall.reviewedPct).toBe(67); // 2 of 3 reviewed
		expect(r.overall.firstReviewHours).toBe(4); // median(2, 6)
		expect(r.overall.reviewHours).toBe(21); // median(20-2, 30-6) = median(18, 24)
		expect(r.overall.mergeHours).toBe(24); // median(10, 24, 36)
		expect(r.overall.postApproveHours).toBe(5); // median(4, 6)
	});

	it('ranks reviewer load by distinct PRs reviewed', () => {
		expect(r.reviewerLoad).toEqual([
			{ reviewer: 'alice', prs: 2 },
			{ reviewer: 'bob', prs: 1 }
		]);
	});

	it('breaks stats down per month', () => {
		expect(r.byMonth).toHaveLength(1);
		expect(r.byMonth[0]).toMatchObject({ month: '2026-06', count: 3 });
	});
});
