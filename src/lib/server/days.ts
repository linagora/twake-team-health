// Pure UTC day/window helpers for the fact store: day keys ("YYYY-MM-DD"),
// rolling windows, and month-sliced day ranges (GitHub search caps one query at
// 1000 results, so long spans are always fetched month by month).
import { monthList, monthKeyOf, addMonths } from '$lib/months';
import { parseMonthKey, monthStart, monthEnd } from './github/months';
import type { DayRange } from './github/metrics';

export const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 30;

const pad = (n: number) => String(n).padStart(2, '0');

/** UTC "YYYY-MM-DD" of an instant. */
export const dayOf = (d: Date): string =>
	`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Shift a "YYYY-MM-DD" day key by `delta` days. */
export const addDays = (day: string, delta: number): string =>
	dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS));

/** First instant of a day, epoch ms (UTC). */
export const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
/** Final instant of a day, epoch ms (UTC). */
export const dayEndMs = (day: string): number => Date.parse(`${day}T23:59:59.999Z`);

export type MsWindow = { startMs: number; endMs: number };

/** Two adjacent `days`-day windows ending at `endDay` (inclusive), as ms ranges:
 * current = [endDay-(N-1) .. endDay], previous = the N days before that. They
 * tile the last 2N days with no overlap or gap. */
export function rollingWindows(
	endDay: string,
	days = WINDOW_DAYS,
): { current: MsWindow; previous: MsWindow } {
	const curStart = addDays(endDay, -(days - 1));
	const prevEnd = addDays(curStart, -1);
	const prevStart = addDays(prevEnd, -(days - 1));
	return {
		current: { startMs: dayStartMs(curStart), endMs: dayEndMs(endDay) },
		previous: { startMs: dayStartMs(prevStart), endMs: dayEndMs(prevEnd) },
	};
}

/** Inclusive day span sliced into calendar-month ranges, clamped to the span. */
export function monthSlicedRanges(fromDay: string, toDay: string): DayRange[] {
	if (fromDay > toDay) return [];
	return monthList(fromDay.slice(0, 7), toDay.slice(0, 7)).map((key) => {
		const m = parseMonthKey(key);
		const s = monthStart(m) < fromDay ? fromDay : monthStart(m);
		const e = monthEnd(m) > toDay ? toDay : monthEnd(m);
		return { s, e };
	});
}

/** Month-end days strictly inside the span (for open-stock snapshots), plus the
 * span end itself when it isn't already a month end. */
export function snapshotDays(fromDay: string, toDay: string): string[] {
	const days = monthSlicedRanges(fromDay, toDay).map((r) => r.e);
	return [...new Set(days)];
}

/** "YYYY-MM" of the last COMPLETE month at `now` (UTC). */
export const lastCompleteMonthKey = (now: Date): string => addMonths(monthKeyOf(now), -1);
