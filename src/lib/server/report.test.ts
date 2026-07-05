import { describe, it, expect } from 'vitest';
import { resolveReportShape } from './report';
import { monthKey } from './github/months';
import type { Selection } from './github/types';

// July 5, 2026: the meeting-week case — July is in progress, June is complete.
const NOW = new Date('2026-07-05T09:00:00Z');

const sel = (o: Partial<Selection> = {}): Selection => ({
	repos: [{ owner: 'linagora', repo: 'a' }],
	members: [],
	months: 12,
	memberMonths: 3,
	...o,
});

describe('resolveReportShape', () => {
	it('a rolling selection buckets only COMPLETE months (never the in-progress one)', () => {
		const s = resolveReportShape(sel(), NOW);
		expect(s.months).toHaveLength(12);
		expect(monthKey(s.months.at(-1)!)).toBe('2026-06'); // June, not July
		expect(monthKey(s.months[0])).toBe('2025-07');
		expect(s.windowEndDay).toBe('2026-07-05'); // rolling windows still end today
	});

	it('member months are the suffix of the same complete-month window', () => {
		const s = resolveReportShape(sel(), NOW);
		expect(s.memberMonths.map(monthKey)).toEqual(['2026-04', '2026-05', '2026-06']);
	});

	it('memberMonths never exceeds months', () => {
		const s = resolveReportShape(sel({ months: 2, memberMonths: 6 }), NOW);
		expect(s.memberMonths).toHaveLength(2);
	});

	it('an explicit historical `to` is honored and anchors the rolling window', () => {
		const s = resolveReportShape(sel({ to: '2026-04' }), NOW);
		expect(monthKey(s.months.at(-1)!)).toBe('2026-04');
		expect(s.windowEndDay).toBe('2026-04-30');
	});

	it('a `to` pointing at the in-progress month is treated as rolling', () => {
		const s = resolveReportShape(sel({ to: '2026-07' }), NOW);
		expect(monthKey(s.months.at(-1)!)).toBe('2026-06');
		expect(s.windowEndDay).toBe('2026-07-05');
	});

	it('fact span covers both the chart months and the previous rolling window', () => {
		const s = resolveReportShape(sel(), NOW);
		// 12 chart months reach back further than 60 days: span starts at the window.
		expect(s.spanStartDay).toBe('2025-07-01');
		// member window (Apr 1) is older than 59 days back (May 7): activity span
		// starts at the member window.
		expect(s.activityStartDay).toBe('2026-04-01');
	});

	it('activity span extends to the rolling window when the member window is shorter', () => {
		const s = resolveReportShape(sel({ months: 12, memberMonths: 1 }), NOW);
		// One member month (June) starts after the 60-day window start (May 7).
		expect(s.activityStartDay).toBe('2026-05-07');
	});
});
