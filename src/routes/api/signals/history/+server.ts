import { json, error } from '@sveltejs/kit';
import { parseRepoSelection } from '$lib/server/selection';
import { getAppSettings } from '$lib/server/app-config';
import { getSignalHistory } from '$lib/server/signal-history';
import { audit } from '$lib/server/store/audit';
import { scopeKey } from '$lib/signals';
import type { RequestHandler } from './$types';

// Recent daily history of the metrics-derived signals for a scope. The client
// sends the active team's repos; the scope key is derived server-side. History
// exists only for scopes the warm job snapshots (preset teams + global), so a
// custom team with no warmed history simply returns {}.
export const POST: RequestHandler = async ({ request, locals }) => {
	let repos;
	try {
		const body = await request.json().catch(() => ({}));
		repos = parseRepoSelection(body, (await getAppSettings()).maxRepos);
	} catch (e) {
		throw error(400, (e as Error).message);
	}
	const history = await getSignalHistory(scopeKey(repos));
	await audit(locals.user.sub, 'signals.history', { repos: repos.length });
	return json(history);
};
