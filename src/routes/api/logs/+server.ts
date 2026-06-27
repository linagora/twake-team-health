import { json, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { getEvents, type EventKind } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

// Gated: 404 (not 403) for non-viewers so the endpoint's existence isn't revealed.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!isAdmin(locals.user)) throw error(404, 'Not found');
	const kind = url.searchParams.get('kind');
	const user = url.searchParams.get('user') ?? undefined;
	const limit = Number(url.searchParams.get('limit') ?? 200);
	const events = await getEvents({
		kind: (kind as EventKind) || undefined,
		suspicious: url.searchParams.get('suspicious') === 'true',
		user,
		limit: Number.isFinite(limit) ? limit : 200
	});
	return json({ events });
};
