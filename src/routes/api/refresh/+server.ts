import { json, error } from '@sveltejs/kit';
import { parseSelection } from '$lib/server/selection';
import { resolveReportShape } from '$lib/server/report';
import { ensureFactsSynced } from '$lib/server/sync';
import { refreshMetrics } from '$lib/server/metrics-cache';
import { getAppSettings } from '$lib/server/app-config';
import { throwUpstreamError } from '$lib/server/api-errors';
import { audit } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

// Force-refresh a selection: refetch the fact tail from GitHub now (ignoring the
// sync TTL), recompute the report, and replace the cached entry. The warm cron
// keeps data current on its own; this is the manual "refresh now" so a user in a
// meeting never waits for a schedule.
export const POST: RequestHandler = async ({ request, locals }) => {
	let selection;
	try {
		const body = await request.json().catch(() => ({}));
		selection = parseSelection(body);
	} catch (e) {
		throw error(400, (e as Error).message);
	}
	try {
		const now = new Date();
		const shape = resolveReportShape(selection, now);
		const { bugLabels } = await getAppSettings();
		const sync = await ensureFactsSynced(
			selection.repos,
			shape.spanStartDay,
			shape.activityStartDay,
			shape.activityStartDay,
			{ force: true, bugLabels, now },
		);
		const result = await refreshMetrics(selection);
		await audit(locals.user.sub, 'metrics.refresh', {
			repos: selection.repos.length,
			refreshed: sync.refreshed,
			failed: sync.failed.length,
		});
		return json(result);
	} catch (e) {
		throwUpstreamError(e, 'api/refresh');
	}
};
