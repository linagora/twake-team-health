import { json, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { getSyncStatus } from '$lib/server/store';
import { ensureFactsSynced } from '$lib/server/sync';
import { getAppSettings } from '$lib/server/app-config';
import { lastNMonths, monthStart } from '$lib/server/github/months';
import { resolveDefaultTeams, defaultGlobalRepos } from '$lib/server/preset';
import { hasDb } from '$lib/server/db';
import { audit } from '$lib/server/store/audit';
import type { Repo } from '$lib/server/github/types';
import type { RequestHandler } from './$types';

const rk = (r: Repo) => `${r.owner}/${r.repo}`;

/**
 * Admin: extend every known repo's fact history back to N months ago (default
 * 12). Non-forced: repos already covering the span are untouched; the others
 * fetch only the missing older months, in the background. Use it to make deep
 * windows (a year of member history, long flow trends) instant later instead of
 * blocking the first person who asks for them.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!isAdmin(locals.user)) throw error(403, 'admins only');
	if (!hasDb()) throw error(400, 'requires DATABASE_URL');
	const body = (await request.json().catch(() => ({}))) as { months?: unknown };
	const n = Math.round(Number(body.months ?? 12));
	const months = Number.isFinite(n) ? Math.max(1, Math.min(24, n)) : 12;

	try {
		const now = new Date();
		// Every repo the app knows about: configured teams + global list + anything
		// already synced (covers custom-team repos not in the presets).
		const known = new Map<string, Repo>();
		for (const t of await resolveDefaultTeams())
			for (const r of t.repos) known.set(rk(r), { owner: r.owner, repo: r.repo });
		for (const r of defaultGlobalRepos()) known.set(rk(r), { owner: r.owner, repo: r.repo });
		for (const r of await getSyncStatus()) known.set(rk(r), { owner: r.owner, repo: r.repo });
		const repos = [...known.values()];

		// +1 bucket like reports: N complete months plus the in-progress one.
		const spanStart = monthStart(lastNMonths(months + 1, now)[0]);
		const { bugLabels } = await getAppSettings();
		void ensureFactsSynced(repos, spanStart, spanStart, spanStart, { bugLabels, now })
			.then((r) =>
				console.log(
					`[backfill] extended ${r.refreshed}/${r.synced} repos to ${spanStart}, failed ${r.failed.length}`,
				),
			)
			.catch((e) => console.warn(`[backfill] ${(e as Error).message}`));

		await audit(locals.user.sub, 'sync.backfill', { months, repos: repos.length });
		return json({ ok: true, started: repos.length, from: spanStart });
	} catch (e) {
		throw error(500, (e as Error).message);
	}
};
