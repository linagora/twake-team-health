import { SvelteKitAuth } from '@auth/sveltekit';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';

// Auth bypass is allowed only when explicitly requested, or in local dev with no
// issuer configured. In a production build a missing OIDC_ISSUER does NOT disable
// auth (fail closed) — the app is unusable until SSO is configured, rather than
// silently exposing everything as the synthetic dev user.
export const AUTH_DISABLED = env.AUTH_DISABLED === 'true' || (!env.OIDC_ISSUER && dev);

// Admins (allowed to edit app-wide settings) are listed by OIDC subject in
// ADMIN_SUBS. With auth disabled the synthetic dev user is treated as admin so
// local dev can use the settings UI; in prod with no ADMIN_SUBS, nobody is admin
// (settings stay read-only), which preserves the current env-only behavior.
export function isAdmin(sub: string | undefined | null): boolean {
	if (AUTH_DISABLED) return true;
	if (!sub) return false;
	return (env.ADMIN_SUBS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.includes(sub);
}

// Generic OIDC client pointed at the registration service (authorization code +
// PKCE; session in an encrypted JWT cookie — no server-side session store).
export const { handle: authHandle, signIn, signOut } = SvelteKitAuth({
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
