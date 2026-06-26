export type Month = { year: number; month: number }; // month is 1-12

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM" key for a month. */
export const monthKey = (m: Month) => `${m.year}-${pad(m.month)}`;

/** First day of the month, "YYYY-MM-DD". */
export const monthStart = (m: Month) => `${m.year}-${pad(m.month)}-01`;

/** Last day of the month, "YYYY-MM-DD". */
export function monthEnd(m: Month): string {
	const lastDay = new Date(Date.UTC(m.year, m.month, 0)).getUTCDate();
	return `${m.year}-${pad(m.month)}-${pad(lastDay)}`;
}

/** Epoch ms of the final instant of the month (UTC) — the point after which a
 * completed month's data can no longer change. */
export const monthEndMs = (m: Month): number => Date.parse(monthEnd(m) + 'T23:59:59.999Z');

/**
 * The last `n` months ending with (and including) the current month, ascending.
 * Including the in-progress month is intentional, so "today's changes" show up.
 */
export function lastNMonths(n: number, now: Date = new Date()): Month[] {
	const out: Month[] = [];
	let year = now.getUTCFullYear();
	let month = now.getUTCMonth() + 1; // 1-12
	for (let i = 0; i < n; i++) {
		out.unshift({ year, month });
		month -= 1;
		if (month === 0) {
			month = 12;
			year -= 1;
		}
	}
	return out;
}
