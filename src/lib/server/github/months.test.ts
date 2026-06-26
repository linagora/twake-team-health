import { describe, it, expect } from 'vitest';
import { monthKey, monthStart, monthEnd, lastNMonths } from './months';

describe('monthEnd', () => {
	it('handles 30/31-day months and leap-year February', () => {
		expect(monthEnd({ year: 2026, month: 1 })).toBe('2026-01-31');
		expect(monthEnd({ year: 2026, month: 4 })).toBe('2026-04-30');
		expect(monthEnd({ year: 2024, month: 2 })).toBe('2024-02-29'); // leap
		expect(monthEnd({ year: 2025, month: 2 })).toBe('2025-02-28'); // non-leap
	});
});

describe('monthKey / monthStart', () => {
	it('zero-pads the month', () => {
		expect(monthKey({ year: 2026, month: 3 })).toBe('2026-03');
		expect(monthStart({ year: 2026, month: 3 })).toBe('2026-03-01');
	});
});

describe('lastNMonths', () => {
	it('returns n ascending months ending with the current one', () => {
		const ms = lastNMonths(3, new Date('2026-06-15T12:00:00Z'));
		expect(ms.map(monthKey)).toEqual(['2026-04', '2026-05', '2026-06']);
	});

	it('rolls over the year boundary', () => {
		const ms = lastNMonths(3, new Date('2026-01-10T00:00:00Z'));
		expect(ms.map(monthKey)).toEqual(['2025-11', '2025-12', '2026-01']);
	});

	it('uses UTC, not local time', () => {
		// Just before UTC midnight on the 1st: still January in UTC.
		const ms = lastNMonths(1, new Date('2026-01-01T00:30:00Z'));
		expect(ms.map(monthKey)).toEqual(['2026-01']);
	});
});
