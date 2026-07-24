import { describe, it, expect } from 'vitest';
import {
	isMonthKey,
	monthKeyOf,
	addMonths,
	monthCount,
	monthList,
	recentMonthKeys,
	completeMonths,
	withoutEmptyCurrentMonth,
} from './months';

describe('month key helpers', () => {
	it('validates YYYY-MM keys', () => {
		expect(isMonthKey('2026-06')).toBe(true);
		expect(isMonthKey('2026-12')).toBe(true);
		expect(isMonthKey('2026-01')).toBe(true);
		expect(isMonthKey('2026-6')).toBe(false);
		expect(isMonthKey('2026-13')).toBe(false); // month out of range
		expect(isMonthKey('2026-00')).toBe(false);
		expect(isMonthKey('nope')).toBe(false);
		expect(isMonthKey(undefined)).toBe(false);
	});

	it('formats a date as a UTC month key', () => {
		expect(monthKeyOf(new Date('2026-06-15T12:00:00Z'))).toBe('2026-06');
		expect(monthKeyOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
	});

	it('adds months across year boundaries', () => {
		expect(addMonths('2026-06', 1)).toBe('2026-07');
		expect(addMonths('2026-01', -1)).toBe('2025-12');
		expect(addMonths('2026-06', -12)).toBe('2025-06');
		expect(addMonths('2026-11', 3)).toBe('2027-02');
	});

	it('counts months inclusively, order-independent', () => {
		expect(monthCount('2026-06', '2026-06')).toBe(1);
		expect(monthCount('2026-01', '2026-06')).toBe(6);
		expect(monthCount('2026-06', '2026-01')).toBe(6);
	});

	it('lists months ascending and inclusive, order-independent', () => {
		expect(monthList('2026-04', '2026-06')).toEqual(['2026-04', '2026-05', '2026-06']);
		expect(monthList('2026-06', '2026-04')).toEqual(['2026-04', '2026-05', '2026-06']);
		expect(monthList('2025-12', '2026-01')).toEqual(['2025-12', '2026-01']);
	});

	it('builds the last N month keys ending at now', () => {
		const now = new Date('2026-06-15T00:00:00Z');
		expect(recentMonthKeys(3, now)).toEqual(['2026-04', '2026-05', '2026-06']);
		expect(recentMonthKeys(1, now)).toEqual(['2026-06']);
	});
});

describe('completeMonths', () => {
	const now = new Date('2026-07-03T09:00:00Z'); // early July: June complete, July partial

	it('drops the in-progress calendar month', () => {
		const rows = [{ month: '2026-05' }, { month: '2026-06' }, { month: '2026-07' }];
		expect(completeMonths(rows, now).map((r) => r.month)).toEqual(['2026-05', '2026-06']);
	});

	it('is a no-op for a historical series that ends before the current month', () => {
		const rows = [{ month: '2026-03' }, { month: '2026-04' }];
		expect(completeMonths(rows, now)).toEqual(rows);
	});

	it('keeps extra fields on the rows', () => {
		const rows = [
			{ month: '2026-06', merged: 5 },
			{ month: '2026-07', merged: 1 },
		];
		expect(completeMonths(rows, now)).toEqual([{ month: '2026-06', merged: 5 }]);
	});

	it('accepts a month key when the caller already resolved "now"', () => {
		const rows = [{ month: '2026-06' }, { month: '2026-07' }];
		expect(completeMonths(rows, '2026-07').map((r) => r.month)).toEqual(['2026-06']);
	});
});

describe('withoutEmptyCurrentMonth', () => {
	const now = new Date('2026-07-03T09:00:00Z');
	const hasData = (r: { count: number }) => r.count > 0;

	it('drops a zero-filled in-progress month', () => {
		const rows = [
			{ month: '2026-06', count: 8 },
			{ month: '2026-07', count: 0 },
		];
		expect(withoutEmptyCurrentMonth(rows, hasData, now).map((r) => r.month)).toEqual(['2026-06']);
	});

	it('keeps the in-progress month once it has any data', () => {
		const rows = [
			{ month: '2026-06', count: 8 },
			{ month: '2026-07', count: 1 },
		];
		expect(withoutEmptyCurrentMonth(rows, hasData, now)).toEqual(rows);
	});

	it('never drops a complete month, even an empty one', () => {
		const rows = [
			{ month: '2026-05', count: 3 },
			{ month: '2026-06', count: 0 },
		];
		expect(withoutEmptyCurrentMonth(rows, hasData, now)).toEqual(rows);
	});

	it('tolerates an empty series', () => {
		expect(withoutEmptyCurrentMonth([], hasData, now)).toEqual([]);
	});
});
