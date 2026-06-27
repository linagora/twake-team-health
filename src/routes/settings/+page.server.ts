import { error, fail } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { getAppSettings, setAppSettings } from '$lib/server/app-config';
import { listRepos } from '$lib/server/discovery';
import { DEFAULT_TARGETS } from '$lib/signals';
import type { Repo } from '$lib/server/github/types';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!isAdmin(locals.user)) throw error(403, 'Admins only');
	let repos: Repo[] = [];
	try {
		repos = await listRepos();
	} catch {
		// Discovery can be rate limited; the editor still shows the current selection.
	}
	return { settings: await getAppSettings(), repos };
};

const SIGNAL_KEYS = Object.keys(DEFAULT_TARGETS) as (keyof typeof DEFAULT_TARGETS)[];

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const fd = await request.formData();
		const num = (k: string) => Number(fd.get(k));

		const signals: Record<string, number> = {};
		for (const k of SIGNAL_KEYS) {
			const v = fd.get(`signal.${k}`);
			if (v != null && v !== '') signals[k] = Number(v);
		}
		const globalRepos = fd.getAll('repos').map((s) => {
			const [owner, ...rest] = String(s).split('/');
			return { owner, repo: rest.join('/') } as Repo;
		});

		try {
			// setAppSettings sanitizes (allowlist repos, clamp numbers) and merges.
			const saved = await setAppSettings({
				globalRepos,
				globalMonths: num('globalMonths'),
				defaultMonths: num('defaultMonths'),
				defaultMemberMonths: num('defaultMemberMonths'),
				attentionStaleDays: num('attentionStaleDays'),
				attentionAgingDays: num('attentionAgingDays'),
				signals
			});
			return { saved };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	}
};
