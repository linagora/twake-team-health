/** Authorize a cron/automation request by a shared bearer secret. Returns false
 * when no secret is configured, so the endpoint stays disabled by default rather
 * than open. */
export function bearerAuthorized(header: string | null, secret: string | undefined): boolean {
	if (!secret) return false;
	return header === `Bearer ${secret}`;
}
