import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { bearerAuthorized } from '$lib/server/cron-auth';
import { warmAll } from '$lib/server/warm';
import type { RequestHandler } from './$types';

/**
 * Token-protected warm endpoint for a scheduler, e.g.:
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/warm
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!bearerAuthorized(request.headers.get('authorization'), env.CRON_SECRET)) {
		throw error(401, 'unauthorized');
	}
	return json(await warmAll());
};
