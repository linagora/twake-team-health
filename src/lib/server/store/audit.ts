import { and, desc, eq, or } from 'drizzle-orm';
import { db, hasDb } from '../db';
import { auditLog } from '../db/schema';

export type EventKind = 'http' | 'action' | 'security';

export type EventInput = {
	userSub: string;
	userEmail?: string | null;
	kind?: EventKind;
	action: string;
	method?: string | null;
	path?: string | null;
	status?: number | null;
	durationMs?: number | null;
	ip?: string | null;
	userAgent?: string | null;
	suspicious?: boolean;
	detail?: Record<string, unknown> | null;
};

/** Persist one wide event. Also emits a structured stdout line so events are
 * observable in logs even without the database. Best-effort: never throws. */
export async function logEvent(e: EventInput): Promise<void> {
	const kind = e.kind ?? 'action';
	// Canonical log line (one structured event per line) for stdout observability.
	const line = {
		evt: kind,
		user: e.userSub,
		action: e.action,
		...(e.method ? { method: e.method } : {}),
		...(e.path ? { path: e.path } : {}),
		...(e.status != null ? { status: e.status } : {}),
		...(e.durationMs != null ? { ms: e.durationMs } : {}),
		...(e.suspicious ? { suspicious: true } : {})
	};
	console.log(`[event] ${JSON.stringify(line)}`);
	if (!hasDb()) return;
	try {
		await db()
			.insert(auditLog)
			.values({
				userSub: e.userSub,
				userEmail: e.userEmail ?? null,
				kind,
				action: e.action,
				method: e.method ?? null,
				path: e.path ?? null,
				status: e.status ?? null,
				durationMs: e.durationMs ?? null,
				ip: e.ip ?? null,
				userAgent: e.userAgent ?? null,
				suspicious: e.suspicious ?? false,
				detail: e.detail ?? null
			});
	} catch {
		/* logging must never break the request */
	}
}

export type EventFilter = { kind?: EventKind; suspicious?: boolean; user?: string; limit?: number };

/** Recent events, newest first, for the admin log viewer. `user` matches sub or email. */
export async function getEvents(f: EventFilter = {}) {
	if (!hasDb()) return [];
	const conds = [];
	if (f.kind) conds.push(eq(auditLog.kind, f.kind));
	if (f.suspicious) conds.push(eq(auditLog.suspicious, true));
	if (f.user) {
		const u = f.user.toLowerCase();
		conds.push(or(eq(auditLog.userSub, f.user), eq(auditLog.userEmail, u)));
	}
	const limit = Math.min(Math.max(1, f.limit ?? 200), 1000);
	const base = db().select().from(auditLog);
	const q = conds.length ? base.where(and(...conds)) : base;
	return q.orderBy(desc(auditLog.ts)).limit(limit);
}

/** Best-effort per-user semantic action log (kind 'action'). */
export async function audit(
	userSub: string,
	action: string,
	detail?: Record<string, unknown>
): Promise<void> {
	await logEvent({ userSub, kind: 'action', action, detail: detail ?? null });
}
