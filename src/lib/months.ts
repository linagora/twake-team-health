// Pure "YYYY-MM" month helpers, safe to import on both client and server.
// (Server-side Month{year,month} helpers live in src/lib/server/github/months.ts.)

const pad = (n: number) => String(n).padStart(2, '0');

export const isMonthKey = (s: unknown): s is string => {
	if (typeof s !== 'string' || !/^\d{4}-\d{2}$/.test(s)) return false;
	const month = Number(s.slice(5, 7));
	return month >= 1 && month <= 12;
};

/** "YYYY-MM" for a date (UTC), defaulting to now. */
export function monthKeyOf(d: Date = new Date()): string {
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Absolute month index (year*12 + month-1) for ordering/arithmetic. */
function monthIndex(key: string): number {
	const [y, m] = key.split('-').map(Number);
	return y * 12 + (m - 1);
}

function keyFromIndex(idx: number): string {
	const y = Math.floor(idx / 12);
	const m = (idx % 12) + 1;
	return `${y}-${pad(m)}`;
}

/** Shift a month key by `delta` months (negative = earlier). */
export function addMonths(key: string, delta: number): string {
	return keyFromIndex(monthIndex(key) + delta);
}

/** Inclusive count of months between two keys (order-independent, min 1). */
export function monthCount(fromKey: string, toKey: string): number {
	return Math.abs(monthIndex(toKey) - monthIndex(fromKey)) + 1;
}

/** Inclusive list of month keys between two keys, ascending (order-independent). */
export function monthList(fromKey: string, toKey: string): string[] {
	const lo = Math.min(monthIndex(fromKey), monthIndex(toKey));
	const hi = Math.max(monthIndex(fromKey), monthIndex(toKey));
	const out: string[] = [];
	for (let i = lo; i <= hi; i++) out.push(keyFromIndex(i));
	return out;
}

/** The last `n` month keys ending at `now`, ascending (for range pickers). */
export function recentMonthKeys(n: number, now: Date = new Date()): string[] {
	const end = monthKeyOf(now);
	return monthList(addMonths(end, -(n - 1)), end);
}

/** Drop the in-progress calendar month from a month-keyed series so charts only
 * plot complete months (no stub bar in the first days of a month). A historical
 * window already ends before the current month, so this is a no-op there. */
export function completeMonths<T extends { month: string }>(
	rows: T[],
	now: Date = new Date(),
): T[] {
	const current = monthKeyOf(now);
	return rows.filter((r) => r.month < current);
}
