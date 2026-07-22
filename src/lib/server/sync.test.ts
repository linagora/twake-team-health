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
		reviewBackfilledFrom: string | null;
		syncedThrough: string;
		fetchedAt: Date;
	}> = {},
) => ({
	backfilledFrom: SPAN,
	activityBackfilledFrom: ACTIVITY,
	reviewBackfilledFrom: ACTIVITY as string | null,
	syncedThrough: TODAY,
	fetchedAt: new Date(NOW_MS - 60_000), // synced a minute ago
	...o,
});

describe('planSync', () => {
	it('first sight of a repo backfills the whole span up to today', () => {
		const plan = planSync(null, SPAN, ACTIVITY, ACTIVITY, TODAY, NOW_MS)!;
		expect(plan.factRanges[0]).toEqual({ s: '2025-07-01', e: '2025-07-31' });
		expect(plan.factRanges.at(-1)).toEqual({ s: '2026-07-01', e: '2026-07-05' });
		expect(plan.activityRanges[0]).toEqual({ s: '2026-04-01', e: '2026-04-30' });
		expect(plan.reviewRanges[0]).toEqual({ s: '2026-04-01', e: '2026-04-30' });
		expect(plan.releaseSince).toBe(SPAN);
		expect(plan.stockDays).toContain('2026-06-30'); // month-end snapshots
		expect(plan.stockDays).toContain('2026-07-05'); // as-of today
		expect(plan.hasBackfill).toBe(true);
		expect(plan.next).toEqual({
			backfilledFrom: SPAN,
			activityBackfilledFrom: ACTIVITY,
			reviewBackfilledFrom: ACTIVITY,
			syncedThrough: TODAY,
		});
	});

	it('a fresh repo needs nothing', () => {
		expect(planSync(row(), SPAN, ACTIVITY, ACTIVITY, TODAY, NOW_MS)).toBeNull();
	});

	it('a repo synced through yesterday refreshes an overlapping tail (no backfill)', () => {
		const plan = planSync(
			row({ syncedThrough: '2026-07-04', fetchedAt: new Date(NOW_MS - 7 * 3600_000) }),
			SPAN,
			ACTIVITY,
			ACTIVITY,
			TODAY,
			NOW_MS,
		)!;
		// 2-day overlap: anything merged/closed around the last cutoff is re-seen.
		expect(plan.factRanges).toEqual([{ s: '2026-07-02', e: '2026-07-05' }]);
		expect(plan.activityRanges).toEqual([{ s: '2026-07-02', e: '2026-07-05' }]);
		expect(plan.reviewRanges).toEqual([{ s: '2026-07-02', e: '2026-07-05' }]);
		expect(plan.stockDays).toEqual(['2026-07-05']);
		expect(plan.hasBackfill).toBe(false); // tail-only: SWR may background it
		expect(plan.next.syncedThrough).toBe(TODAY);
	});

	it('a stale refresh reconciles late edits across the whole span (updated: window)', () => {
		// An issue created earlier but relabeled after first ingest is missed by the
		// created/closed tail; the reconcile window re-pulls anything updated since.
		const plan = planSync(
			row({ syncedThrough: '2026-07-04', fetchedAt: new Date(NOW_MS - 7 * 3600_000) }),
			SPAN,
			ACTIVITY,
			ACTIVITY,
			TODAY,
			NOW_MS,
		)!;
		expect(plan.issueReconcile).toEqual({ updatedSince: '2026-07-02', createdFrom: SPAN });
	});

	it('first sight needs no reconcile (everything is freshly created-fetched)', () => {
		const plan = planSync(null, SPAN, ACTIVITY, ACTIVITY, TODAY, NOW_MS)!;
		expect(plan.issueReconcile).toBeNull();
	});

	it('an expired TTL refreshes even when the watermark day is today', () => {
		const plan = planSync(
			row({ fetchedAt: new Date(NOW_MS - 7 * 3600_000) }),
			SPAN,
			ACTIVITY,
			ACTIVITY,
			TODAY,
			NOW_MS,
		)!;
		expect(plan.factRanges.at(-1)!.e).toBe(TODAY);
		expect(plan.hasBackfill).toBe(false);
	});

	it('force refreshes the tail regardless of freshness', () => {
		const plan = planSync(row(), SPAN, ACTIVITY, ACTIVITY, TODAY, NOW_MS, true)!;
		expect(plan.factRanges.length).toBeGreaterThan(0);
	});

	it('a widened window extends the backfill backwards and flags hasBackfill', () => {
		const plan = planSync(
			row({ backfilledFrom: '2026-01-01' }),
			'2025-07-01',
			ACTIVITY,
			ACTIVITY,
			TODAY,
			NOW_MS,
		)!;
		expect(plan.factRanges[0]).toEqual({ s: '2025-07-01', e: '2025-07-31' });
		expect(plan.factRanges.at(-1)).toEqual({ s: '2025-12-01', e: '2025-12-31' }); // stops before existing facts
		expect(plan.activityRanges).toEqual([]); // activity window unchanged
		expect(plan.hasBackfill).toBe(true); // holes in history: must block
		expect(plan.issueReconcile).toBeNull(); // not stale: no tail, no reconcile
		expect(plan.next.backfilledFrom).toBe('2025-07-01');
		expect(plan.next.syncedThrough).toBe(TODAY); // untouched watermark day
	});

	it('a widened review window (flow) extends only the review backfill', () => {
		const plan = planSync(row(), SPAN, ACTIVITY, '2025-08-01', TODAY, NOW_MS)!;
		expect(plan.factRanges).toEqual([]);
		expect(plan.activityRanges).toEqual([]);
		expect(plan.reviewRanges[0]).toEqual({ s: '2025-08-01', e: '2025-08-31' });
		expect(plan.reviewRanges.at(-1)).toEqual({ s: '2026-03-01', e: '2026-03-31' });
		expect(plan.hasBackfill).toBe(true);
		expect(plan.next.reviewBackfilledFrom).toBe('2025-08-01');
	});

	it('legacy rows without a review watermark refetch ALL reviews (self-heal)', () => {
		// Rows stored before the bot/comment fields existed are not trustworthy for
		// flow; a full refetch rewrites them in place via the id-keyed upsert.
		const plan = planSync(
			row({ reviewBackfilledFrom: null }),
			SPAN,
			ACTIVITY,
			SPAN,
			TODAY,
			NOW_MS,
		)!;
		expect(plan.reviewRanges[0]).toEqual({ s: '2025-07-01', e: '2025-07-31' });
		expect(plan.reviewRanges.at(-1)).toEqual({ s: '2026-07-01', e: '2026-07-05' }); // through today
		expect(plan.hasBackfill).toBe(true);
		expect(plan.next.reviewBackfilledFrom).toBe(SPAN);
	});

	it('a widened member window extends only the activity backfill', () => {
		const plan = planSync(row(), SPAN, '2025-10-01', ACTIVITY, TODAY, NOW_MS)!;
		expect(plan.factRanges).toEqual([]);
		expect(plan.activityRanges[0]).toEqual({ s: '2025-10-01', e: '2025-10-31' });
		expect(plan.activityRanges.at(-1)).toEqual({ s: '2026-03-01', e: '2026-03-31' });
		expect(plan.next.activityBackfilledFrom).toBe('2025-10-01');
	});
});
