import { json, error } from '@sveltejs/kit';
import { getAppSettings, setAppSettings } from '$lib/server/app-config';
import { isAdmin } from '$lib/server/auth';
import { audit } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!isAdmin(locals.user)) throw error(403, 'admins only');
	return json(await getAppSettings());
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!isAdmin(locals.user)) throw error(403, 'admins only');
	const body = await request.json().catch(() => ({}));
	try {
		const settings = await setAppSettings(body as Record<string, unknown>);
		await audit(locals.user.sub, 'config.update', {
			globalRepos: settings.globalRepos.length,
			globalMonths: settings.globalMonths
		});
		return json(settings);
	} catch (e) {
		throw error(400, (e as Error).message);
	}
};
