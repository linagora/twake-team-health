import { error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { getEvents, type EventKind } from '$lib/server/store/audit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	// 404 for non-viewers so the page's existence isn't revealed.
	if (!isAdmin(locals.user)) throw error(404, 'Not found');
	const kind = url.searchParams.get('kind') ?? '';
	const user = url.searchParams.get('user') ?? '';
	const suspicious = url.searchParams.get('suspicious') === 'true';
	const events = await getEvents({
		kind: (kind as EventKind) || undefined,
		user: user || undefined,
		suspicious,
		limit: 300
	});
	return { events, filter: { kind, user, suspicious } };
};
