import { json, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { parseRepoSelection } from '$lib/server/selection';
import { deleteRepoSync } from '$lib/server/store';
import { ensureFactsSynced } from '$lib/server/sync';
import { getAppSettings } from '$lib/server/app-config';
import { lastNMonths, monthStart } from '$lib/server/github/months';
import { GLOBAL_MONTHS, DEFAULT_MEMBER_MONTHS } from '$lib/server/preset';
import { audit } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

/**
 * Admin: full re-sync of one repo from scratch. Drops the watermark and refetches
 * the whole history in the background (upserts rewrite the stored facts in
 * place). Use after label renames, force-pushes, or anything that makes stored
 * history untrustworthy. Reports keep serving the existing facts meanwhile.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!isAdmin(locals.user)) throw error(403, 'admins only');
	let repos;
	try {
		repos = parseRepoSelection(await request.json().catch(() => ({})));
	} catch (e) {
		throw error(400, (e as Error).message);
	}
	try {
		const now = new Date();
		// Re-sync over the widest window the app serves (the global config), so the
		// rebuilt history covers every view.
		const spanStart = monthStart(lastNMonths(GLOBAL_MONTHS + 1, now)[0]);
		const activityStart = monthStart(lastNMonths(DEFAULT_MEMBER_MONTHS + 1, now)[0]);
		const { bugLabels } = await getAppSettings();

		for (const repo of repos) await deleteRepoSync(repo);
		// Background: a full backfill of a busy repo takes minutes; the admin panel
		// polls the status endpoint to watch it land.
		void ensureFactsSynced(repos, spanStart, activityStart, spanStart, { bugLabels, now })
			.then((r) =>
				console.log(
					`[sync-reset] re-synced ${r.refreshed}/${r.synced} repos, failed ${r.failed.length}`,
				),
			)
			.catch((e) => console.warn(`[sync-reset] ${(e as Error).message}`));

		await audit(locals.user.sub, 'sync.reset', { repos: repos.map((r) => `${r.owner}/${r.repo}`) });
		return json({ ok: true, started: repos.length });
	} catch (e) {
		throw error(500, (e as Error).message);
	}
};
