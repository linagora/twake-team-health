import { describe, it, expect } from 'vitest';
import {
	addDays,
	dayOf,
	rollingWindows,
	monthSlicedRanges,
	snapshotDays,
	lastCompleteMonthKey,
} from './days';

describe('day helpers', () => {
	it('formats and shifts UTC days', () => {
		expect(dayOf(new Date('2026-07-05T08:00:00Z'))).toBe('2026-07-05');
		expect(addDays('2026-07-01', -1)).toBe('2026-06-30');
		expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
	});

	it('lastCompleteMonthKey is the month before now', () => {
		expect(lastCompleteMonthKey(new Date('2026-07-05T00:00:00Z'))).toBe('2026-06');
		expect(lastCompleteMonthKey(new Date('2026-01-15T00:00:00Z'))).toBe('2025-12');
	});
});

describe('rollingWindows', () => {
	it('tiles the last 60 days as two adjacent 30-day windows', () => {
		const { current, previous } = rollingWindows('2026-07-05');
		expect(current.startMs).toBe(Date.parse('2026-06-06T00:00:00Z')); // 30 days incl. Jul 5
		expect(current.endMs).toBe(Date.parse('2026-07-05T23:59:59.999Z'));
		expect(previous.endMs).toBe(Date.parse('2026-06-05T23:59:59.999Z')); // no gap
		expect(previous.startMs).toBe(Date.parse('2026-05-07T00:00:00Z'));
	});
});

describe('monthSlicedRanges', () => {
	it('slices a span into calendar months, clamped at both ends', () => {
		expect(monthSlicedRanges('2026-05-15', '2026-07-05')).toEqual([
			{ s: '2026-05-15', e: '2026-05-31' },
			{ s: '2026-06-01', e: '2026-06-30' },
			{ s: '2026-07-01', e: '2026-07-05' },
		]);
	});

	it('handles a span inside one month and an inverted span', () => {
		expect(monthSlicedRanges('2026-06-03', '2026-06-10')).toEqual([
			{ s: '2026-06-03', e: '2026-06-10' },
		]);
		expect(monthSlicedRanges('2026-06-10', '2026-06-03')).toEqual([]);
	});
});

describe('snapshotDays', () => {
	it('yields each backfilled month end plus the span end', () => {
		expect(snapshotDays('2026-05-15', '2026-07-05')).toEqual([
			'2026-05-31',
			'2026-06-30',
			'2026-07-05',
		]);
	});

	it('dedupes when the span ends exactly on a month end', () => {
		expect(snapshotDays('2026-06-01', '2026-06-30')).toEqual(['2026-06-30']);
	});
});
