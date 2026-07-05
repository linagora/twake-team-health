import { json, error } from '@sveltejs/kit';
import { parseSelection } from '$lib/server/selection';
import { resolveReportShape } from '$lib/server/report';
import { ensureFactsSynced } from '$lib/server/sync';
import { refreshMetrics } from '$lib/server/metrics-cache';
import { refreshFlow } from '$lib/server/flow-cache';
import { refreshAttention } from '$lib/server/attention-cache';
import { getAppSettings } from '$lib/server/app-config';
import { monthStart } from '$lib/server/github/months';
import { throwUpstreamError } from '$lib/server/api-errors';
import { audit } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

type Kind = 'metrics' | 'flow' | 'attention';
const KINDS: Kind[] = ['metrics', 'flow', 'attention'];

// Force-refresh what a page actually shows: refetch the fact tail from GitHub
// now (ignoring the sync TTL), recompute the requested report kinds, and replace
// their cached entries — so the Refresh button is never a no-op that re-reads
// the same cache. The warm cron keeps data current on its own; this is the
// manual "refresh now" so a user in a meeting never waits for a schedule.
export const POST: RequestHandler = async ({ request, locals }) => {
	let selection;
	let kinds: Kind[];
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		selection = parseSelection(body);
		const requested = Array.isArray(body.kinds) ? body.kinds : ['metrics'];
		kinds = KINDS.filter((k) => requested.includes(k));
		if (!kinds.length) kinds = ['metrics'];
	} catch (e) {
		throw error(400, (e as Error).message);
	}
	try {
		const now = new Date();
		const shape = resolveReportShape(selection, now);
		const { bugLabels } = await getAppSettings();
		// One forced sync covering every requested kind's span: flow needs review
		// facts back to the chart window's start, metrics only to the member window.
		const reviewStart = kinds.includes('flow')
			? monthStart(shape.months[0])
			: shape.activityStartDay;
		const sync = await ensureFactsSynced(
			selection.repos,
			shape.spanStartDay,
			shape.activityStartDay,
			reviewStart,
			{ force: true, bugLabels, now },
		);

		const done: Kind[] = [];
		if (kinds.includes('metrics')) {
			await refreshMetrics(selection);
			done.push('metrics');
		}
		if (kinds.includes('flow')) {
			await refreshFlow(selection.repos, selection.months, selection.to);
			done.push('flow');
		}
		if (kinds.includes('attention')) {
			await refreshAttention(selection.repos);
			done.push('attention');
		}

		await audit(locals.user.sub, 'metrics.refresh', {
			repos: selection.repos.length,
			kinds: done,
			refreshed: sync.refreshed,
			failed: sync.failed.length,
		});
		return json({
			ok: true,
			kinds: done,
			sync: { refreshed: sync.refreshed, failed: sync.failed.length },
		});
	} catch (e) {
		throwUpstreamError(e, 'api/refresh');
	}
};
