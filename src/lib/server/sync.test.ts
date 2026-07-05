import { describe, it, expect } from 'vitest';
import { planSync } from './sync';

const TODAY = '2026-07-05';
const NOW_MS = Date.parse('2026-07-05T09:00:00Z');
const SPAN = '2025-07-01';
const ACTIVITY = '2026-04-01';

const row = (
	o: Partial<{
		backfilledFrom: string;
		activityBackfilledFrom: string;
		syncedThrough: string;
		fetchedAt: Date;
	}> = {},
) => ({
	backfilledFrom: SPAN,
	activityBackfilledFrom: ACTIVITY,
	syncedThrough: TODAY,
	fetchedAt: new Date(NOW_MS - 60_000), // synced a minute ago
	...o,
});

describe('planSync', () => {
	it('first sight of a repo backfills the whole span up to today', () => {
		const plan = planSync(null, SPAN, ACTIVITY, TODAY, NOW_MS)!;
		expect(plan.factRanges[0]).toEqual({ s: '2025-07-01', e: '2025-07-31' });
		expect(plan.factRanges.at(-1)).toEqual({
			s: '2026-07-01',
			e: '2026-07-05',
		});
		expect(plan.activityRanges[0]).toEqual({
			s: '2026-04-01',
			e: '2026-04-30',
		});
		expect(plan.releaseSince).toBe(SPAN);
		expect(plan.stockDays).toContain('2026-06-30'); // month-end snapshots
		expect(plan.stockDays).toContain('2026-07-05'); // as-of today
		expect(plan.next).toEqual({
			backfilledFrom: SPAN,
			activityBackfilledFrom: ACTIVITY,
			syncedThrough: TODAY,
		});
	});

	it('a fresh repo needs nothing', () => {
		expect(planSync(row(), SPAN, ACTIVITY, TODAY, NOW_MS)).toBeNull();
	});

	it('a repo synced through yesterday refreshes an overlapping tail', () => {
		const plan = planSync(
			row({
				syncedThrough: '2026-07-04',
				fetchedAt: new Date(NOW_MS - 7 * 3600_000),
			}),
			SPAN,
			ACTIVITY,
			TODAY,
			NOW_MS,
		)!;
		// 2-day overlap: anything merged/closed around the last cutoff is re-seen.
		expect(plan.factRanges).toEqual([{ s: '2026-07-02', e: '2026-07-05' }]);
		expect(plan.activityRanges).toEqual([{ s: '2026-07-02', e: '2026-07-05' }]);
		expect(plan.stockDays).toEqual(['2026-07-05']);
		expect(plan.next.syncedThrough).toBe(TODAY);
	});

	it('an expired TTL refreshes even when the watermark day is today', () => {
		const plan = planSync(
			row({ fetchedAt: new Date(NOW_MS - 7 * 3600_000) }),
			SPAN,
			ACTIVITY,
			TODAY,
			NOW_MS,
		)!;
		expect(plan.factRanges.at(-1)!.e).toBe(TODAY);
	});

	it('force refreshes the tail regardless of freshness', () => {
		const plan = planSync(row(), SPAN, ACTIVITY, TODAY, NOW_MS, true)!;
		expect(plan.factRanges.length).toBeGreaterThan(0);
	});

	it('a widened window extends the backfill backwards without a tail refresh', () => {
		const plan = planSync(
			row({ backfilledFrom: '2026-01-01' }),
			'2025-07-01',
			ACTIVITY,
			TODAY,
			NOW_MS,
		)!;
		expect(plan.factRanges[0]).toEqual({ s: '2025-07-01', e: '2025-07-31' });
		expect(plan.factRanges.at(-1)).toEqual({
			s: '2025-12-01',
			e: '2025-12-31',
		}); // stops before existing facts
		expect(plan.activityRanges).toEqual([]); // activity window unchanged
		expect(plan.next.backfilledFrom).toBe('2025-07-01');
		expect(plan.next.syncedThrough).toBe(TODAY); // untouched watermark day
	});

	it('a widened member window extends only the activity backfill', () => {
		const plan = planSync(row(), SPAN, '2025-10-01', TODAY, NOW_MS)!;
		expect(plan.factRanges).toEqual([]);
		expect(plan.activityRanges[0]).toEqual({
			s: '2025-10-01',
			e: '2025-10-31',
		});
		expect(plan.activityRanges.at(-1)).toEqual({
			s: '2026-03-01',
			e: '2026-03-31',
		});
		expect(plan.next.activityBackfilledFrom).toBe('2025-10-01');
	});
});
