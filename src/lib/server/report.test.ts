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
	...o
});

describe('resolveReportShape', () => {
	it('a rolling selection buckets N complete months PLUS the in-progress month', () => {
		const s = resolveReportShape(sel(), NOW);
		// 12 complete months for the charts + July as the through-today bucket.
		expect(s.months).toHaveLength(13);
		expect(monthKey(s.months.at(-1)!)).toBe('2026-07');
		expect(monthKey(s.months.at(-2)!)).toBe('2026-06');
		expect(monthKey(s.months[0])).toBe('2025-07');
		expect(s.windowEndDay).toBe('2026-07-05'); // rolling windows end today
	});

	it('member months follow the same rule (complete window + partial bucket)', () => {
		const s = resolveReportShape(sel(), NOW);
		expect(s.memberMonths.map(monthKey)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07']);
	});

	it('memberMonths never exceeds months', () => {
		const s = resolveReportShape(sel({ months: 2, memberMonths: 6 }), NOW);
		expect(s.memberMonths).toHaveLength(3); // 2 complete + partial
		expect(s.months).toHaveLength(3);
	});

	it('an explicit historical `to` is honored with no extra bucket', () => {
		const s = resolveReportShape(sel({ to: '2026-04' }), NOW);
		expect(s.months).toHaveLength(12);
		expect(monthKey(s.months.at(-1)!)).toBe('2026-04');
		expect(s.windowEndDay).toBe('2026-04-30');
	});

	it('a `to` pointing at the in-progress month is treated as rolling', () => {
		const s = resolveReportShape(sel({ to: '2026-07' }), NOW);
		expect(s.months).toHaveLength(13);
		expect(monthKey(s.months.at(-1)!)).toBe('2026-07');
		expect(s.windowEndDay).toBe('2026-07-05');
	});

	it('fact span covers both the chart months and the previous rolling window', () => {
		const s = resolveReportShape(sel(), NOW);
		// 12 complete months + July reach back further than 60 days.
		expect(s.spanStartDay).toBe('2025-07-01');
		// member window (Apr 1) is older than 59 days back (May 7): activity span
		// starts at the member window.
		expect(s.activityStartDay).toBe('2026-04-01');
	});

	it('activity span extends to the rolling window when the member window is shorter', () => {
		const s = resolveReportShape(sel({ months: 12, memberMonths: 1 }), NOW);
		// One complete member month (June) + July starts after the 60-day window
		// start (May 7), so the window wins.
		expect(s.activityStartDay).toBe('2026-05-07');
	});
});
