import { SvelteKitAuth } from '@auth/sveltekit';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';

// Auth bypass is allowed only when explicitly requested, or in local dev with no
// issuer configured. In a production build a missing OIDC_ISSUER does NOT disable
// auth (fail closed) — the app is unusable until SSO is configured, rather than
// silently exposing everything as the synthetic dev user.
export const AUTH_DISABLED = env.AUTH_DISABLED === 'true' || (!env.OIDC_ISSUER && dev);

type UserRef = { sub?: string | null; email?: string | null } | null | undefined;

function inAllowlist(user: UserRef, listEnv: string | undefined, matchEmail = true): boolean {
	const allow = (listEnv ?? '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (!allow.length || !user) return false;
	const sub = user.sub?.toLowerCase();
	const email = user.email?.toLowerCase();
	return (!!sub && allow.includes(sub)) || (matchEmail && !!email && allow.includes(email));
}

// Admins gate the settings UI and the activity/log viewer. Listed by email OR
// OIDC subject in ADMINS (so the list can be human-readable emails); ADMIN_SUBS
// (subject-only) is kept as a back-compat fallback. With auth disabled the dev
// user is admin; in prod with neither set, nobody is admin (fail closed).
export function isAdmin(user: UserRef): boolean {
	if (AUTH_DISABLED) return true;
	return inAllowlist(user, env.ADMINS) || inAllowlist(user, env.ADMIN_SUBS, false);
}

// Generic OIDC client pointed at the registration service (authorization code +
// PKCE; session in an encrypted JWT cookie — no server-side session store).
export const { handle: authHandle, signOut } = SvelteKitAuth({
	trustHost: true,
	secret: env.AUTH_SECRET,
	providers: [
		{
			id: 'oidc',
			name: 'SSO',
			type: 'oidc',
			issuer: env.OIDC_ISSUER,
			clientId: env.OIDC_CLIENT_ID,
			clientSecret: env.OIDC_CLIENT_SECRET
		}
	],
	callbacks: {
		jwt({ token, profile }) {
			if (profile?.sub) token.sub = profile.sub;
			return token;
		},
		session({ session, token }) {
			if (session.user && token.sub) (session.user as { id?: string }).id = token.sub;
			return session;
		}
	}
});
