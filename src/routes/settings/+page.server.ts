import { error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { getAppSettings } from '$lib/server/app-config';
import { listRepos } from '$lib/server/discovery';
import type { Repo } from '$lib/server/github/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!isAdmin(locals.user.sub)) throw error(403, 'Admins only');
	let repos: Repo[] = [];
	try {
		repos = await listRepos();
	} catch {
		// Discovery can be rate limited; the editor still shows the current selection.
	}
	return { settings: await getAppSettings(), repos };
};
