// Persistence + read for the daily signal-level timeline. Best-effort: with no
// DATABASE_URL it silently does nothing (history is an enhancement, never a
// dependency of serving signals).
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, hasDb } from './db';
import { signalSnapshot } from './db/schema';
import { HISTORY_DAYS, type Signal, type SignalLevel } from '$lib/signals';

// How many days of history to keep / read. The warm job prunes older rows so the
// table stays bounded; the page lays them over this same window.
export { HISTORY_DAYS } from '$lib/signals';

export type SignalHistoryPoint = { day: string; level: SignalLevel; value: string };
/** Per-signal recent history, newest scopes grouped: { [signalId]: points[] } (oldest day first). */
export type SignalHistory = Record<string, SignalHistoryPoint[]>;

/** UTC day key (YYYY-MM-DD) for a timestamp. */
export function dayKey(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/** Upsert today's level/value for each signal under a scope. One row per
 * (scope, signal, day): re-running the same day overwrites (last warm wins). */
export async function upsertSignalSnapshots(scope: string, signals: Signal[], now: Date = new Date()): Promise<void> {
	if (!hasDb() || !signals.length) return;
	const day = dayKey(now);
	const rows = signals.map((s) => ({ scope, signalId: s.id, day, level: s.level, value: s.value }));
	await db()
		.insert(signalSnapshot)
		.values(rows)
		.onConflictDoUpdate({
			target: [signalSnapshot.scope, signalSnapshot.signalId, signalSnapshot.day],
			set: { level: sql`excluded.level`, value: sql`excluded.value`, ts: sql`now()` }
		});
	// Keep the table bounded: drop this scope's rows older than the read window.
	const cutoff = dayKey(new Date(now.getTime() - HISTORY_DAYS * 86_400_000));
	await db().delete(signalSnapshot).where(and(eq(signalSnapshot.scope, scope), lt(signalSnapshot.day, cutoff)));
}

/** Group flat snapshot rows into a per-signal timeline, each oldest-day-first. */
export function groupHistory(rows: { signalId: string; day: string; level: string; value: string }[]): SignalHistory {
	const out: SignalHistory = {};
	for (const r of [...rows].sort((a, b) => a.day.localeCompare(b.day))) {
		(out[r.signalId] ??= []).push({ day: r.day, level: r.level as SignalLevel, value: r.value });
	}
	return out;
}

/** Recent history for a scope, grouped by signal. Empty (not an error) with no DB. */
export async function getSignalHistory(scope: string, days = HISTORY_DAYS, now: Date = new Date()): Promise<SignalHistory> {
	if (!hasDb()) return {};
	const since = dayKey(new Date(now.getTime() - days * 86_400_000));
	const rows = await db()
		.select({
			signalId: signalSnapshot.signalId,
			day: signalSnapshot.day,
			level: signalSnapshot.level,
			value: signalSnapshot.value
		})
		.from(signalSnapshot)
		.where(and(eq(signalSnapshot.scope, scope), gte(signalSnapshot.day, since)));
	return groupHistory(rows);
}
