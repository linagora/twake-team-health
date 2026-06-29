import { sequence } from '@sveltejs/kit/hooks';
import { redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { authHandle, AUTH_DISABLED } from '$lib/server/auth';
import { logEvent } from '$lib/server/store/audit';

const DEV_USER = { sub: 'dev', name: 'Dev User', email: 'dev@local' };

// In-memory per-IP request-rate tracker to flag abusive bursts. Per-instance and
// reset on restart, which is fine for surfacing obvious abuse in the event log.
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 300; // requests/min/IP before an event is flagged suspicious
const ipHits = new Map<string, number[]>();
// Bound the per-IP map so a long-lived process seeing many distinct IPs doesn't
// grow it without limit; sweep entries with no hit inside the window.
const IP_MAP_CAP = 5000;
function abusiveRate(ip: string, now: number): number {
	const arr = (ipHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
	arr.push(now);
	ipHits.set(ip, arr);
	if (ipHits.size > IP_MAP_CAP) {
		for (const [k, v] of ipHits) {
			if (k !== ip && (v.length === 0 || now - v[v.length - 1] >= RATE_WINDOW_MS)) ipHits.delete(k);
		}
	}
	return arr.length;
}

// Don't log framework/static noise; do log page navigations and API calls.
function shouldLog(path: string): boolean {
	if (path.startsWith('/_app/') || path.startsWith('/@')) return false;
	if (path.startsWith('/auth/')) return false; // Auth.js internals
	if (path.startsWith('/favicon') || path.startsWith('/.well-known')) return false;
	return true;
}

// Wide-event request logger: one row per request, flagging auth failures, rate
// limiting, and per-IP bursts as security/abuse events. Best-effort, after the
// response so it never delays it.
const logEvents: Handle = async ({ event, resolve }) => {
	const start = Date.now();
	const response = await resolve(event);
	const path = event.url.pathname;
	if (!shouldLog(path)) return response;

	let ip: string | null = null;
	try {
		ip = event.getClientAddress();
	} catch {
		/* address unavailable in some environments */
	}
	const rateCount = ip ? abusiveRate(ip, Date.now()) : 0;
	const status = response.status;
	const rateAbuse = rateCount > RATE_LIMIT;
	const suspicious = status === 401 || status === 403 || status === 429 || rateAbuse;
	const user = event.locals.user;
	void logEvent({
		userSub: user?.sub ?? 'anonymous',
		userEmail: user?.email ?? null,
		kind: suspicious ? 'security' : 'http',
		action: `${event.request.method} ${path}`,
		method: event.request.method,
		path,
		status,
		durationMs: Date.now() - start,
		ip,
		userAgent: event.request.headers.get('user-agent'),
		suspicious,
		detail: rateAbuse ? { reason: 'rate-abuse', reqsInWindow: rateCount } : undefined
	});
	return response;
};

// Populate locals.user and gate every route behind a session (except the Auth.js
// endpoints). With AUTH_DISABLED, inject a synthetic user so local dev needs no SSO.
const guard: Handle = async ({ event, resolve }) => {
	if (AUTH_DISABLED) {
		event.locals.user = DEV_USER;
		return resolve(event);
	}

	const path = event.url.pathname;
	if (path === '/auth' || path.startsWith('/auth/')) return resolve(event);
	// The sign-in page itself must be reachable without a session.
	if (path === '/login') return resolve(event);
	// Cron endpoints carry no session; they authorize themselves with CRON_SECRET.
	if (path.startsWith('/api/cron/')) return resolve(event);

	const session = await event.locals.auth();
	if (!session?.user) {
		// API clients get JSON 401 (not an HTML redirect they'd try to JSON.parse);
		// page navigations are redirected to sign in.
		if (path.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json' }
			});
		}
		throw redirect(303, `/login?callbackUrl=${encodeURIComponent(path)}`);
	}
	const u = session.user as { id?: string; name?: string | null; email?: string | null };
	const sub = u.id ?? u.email;
	if (!sub) {
		// Standard OIDC always provides `sub`; without it distinct users would collide
		// on the fallback. Surface it loudly rather than silently merging identities.
		console.warn('[auth] session user has no id or email; falling back to a shared "unknown" subject');
	}
	event.locals.user = { sub: sub ?? 'unknown', name: u.name ?? '', email: u.email ?? '' };
	return resolve(event);
};

// Defense-in-depth response headers. (A strict CSP is intentionally left out: it
// needs SvelteKit's nonce integration via svelte.config to avoid breaking the
// app's inline hydration script and styles.)
const securityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
	return response;
};

export const handle: Handle = AUTH_DISABLED
	? sequence(logEvents, guard, securityHeaders)
	: sequence(authHandle, logEvents, guard, securityHeaders);

// Capture unexpected (5xx) errors with their message into the event log, and
// return a safe message so internals never reach the client.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (status >= 500) console.error(`[error] ${status} ${event.url.pathname}`, error);
	const user = event.locals.user;
	void logEvent({
		userSub: user?.sub ?? 'anonymous',
		userEmail: user?.email ?? null,
		kind: 'http',
		action: `error ${status} ${event.url.pathname}`,
		method: event.request.method,
		path: event.url.pathname,
		status,
		suspicious: false,
		detail: { message: (error as Error)?.message ?? String(error) }
	});
	return { message: status >= 500 ? 'Internal error' : message };
};
