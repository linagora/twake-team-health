import { sequence } from '@sveltejs/kit/hooks';
import { redirect, type Handle } from '@sveltejs/kit';
import { authHandle, AUTH_DISABLED } from '$lib/server/auth';

const DEV_USER = { sub: 'dev', name: 'Dev User', email: 'dev@local' };

// Populate locals.user and gate every route behind a session (except the Auth.js
// endpoints). With AUTH_DISABLED, inject a synthetic user so local dev needs no SSO.
const guard: Handle = async ({ event, resolve }) => {
	if (AUTH_DISABLED) {
		event.locals.user = DEV_USER;
		return resolve(event);
	}

	const path = event.url.pathname;
	if (path === '/auth' || path.startsWith('/auth/')) return resolve(event);
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
		throw redirect(303, `/auth/signin?callbackUrl=${encodeURIComponent(path)}`);
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
	? sequence(guard, securityHeaders)
	: sequence(authHandle, guard, securityHeaders);
