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

/** Best-effort per-user semantic action log (kind 'action'). */
export async function audit(
	userSub: string,
	action: string,
	detail?: Record<string, unknown>
): Promise<void> {
	await logEvent({ userSub, kind: 'action', action, detail: detail ?? null });
}
