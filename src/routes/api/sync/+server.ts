import { json, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { getSyncStatus } from '$lib/server/store';
import { hasDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Admin: per-repo sync watermarks + fact counts, for the Settings sync panel. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!isAdmin(locals.user)) throw error(403, 'admins only');
	if (!hasDb()) return json({ repos: [] });
	try {
		return json({ repos: await getSyncStatus() });
	} catch (e) {
		throw error(500, (e as Error).message);
	}
};
