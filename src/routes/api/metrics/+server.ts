import { json, error } from '@sveltejs/kit';
import { getMetrics } from '$lib/server/metrics-cache';
import { parseSelection } from '$lib/server/selection';
import { getAppSettings } from '$lib/server/app-config';
import { defaultSelection } from '$lib/server/preset';
import { throwUpstreamError } from '$lib/server/api-errors';
import { audit } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	let selection;
	try {
		const body = await request.json().catch(() => ({}));
		selection = parseSelection(body, await getAppSettings());
	} catch (e) {
		throw error(400, (e as Error).message);
	}
	try {
		const result = await getMetrics(selection);
		await audit(locals.user.sub, 'report.generate', {
			repos: selection.repos.length,
			members: selection.members.length,
			months: selection.months
		});
		return json(result);
	} catch (e) {
		throwUpstreamError(e, 'api/metrics');
	}
};

// Convenience: GET returns metrics for the built-in default selection.
export const GET: RequestHandler = async () => {
	try {
		return json(await getMetrics(defaultSelection()));
	} catch (e) {
		throwUpstreamError(e, 'api/metrics');
	}
};
