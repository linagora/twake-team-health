import { json, error } from '@sveltejs/kit';
import { getFlow } from '$lib/server/flow-cache';
import { parseRepoSelection } from '$lib/server/selection';
import { getAppSettings } from '$lib/server/app-config';
import { isMonthKey } from '$lib/months';
import { throwUpstreamError } from '$lib/server/api-errors';
import { audit } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	let repos;
	let months = 12;
	let to: string | undefined;
	try {
		const body = await request.json().catch(() => ({}));
		repos = parseRepoSelection(body, (await getAppSettings()).maxRepos);
		const n = Math.round(Number((body as { months?: number }).months ?? 12));
		months = Number.isFinite(n) ? Math.max(1, Math.min(24, n)) : 12;
		const rawTo = (body as { to?: unknown }).to;
		to = isMonthKey(rawTo) ? rawTo : undefined;
	} catch (e) {
		throw error(400, (e as Error).message);
	}
	try {
		const result = await getFlow(repos, months, to);
		await audit(locals.user.sub, 'flow.view', { repos: repos.length, months, to });
		return json(result);
	} catch (e) {
		throwUpstreamError(e, 'api/flow');
	}
};
