import { createCache } from './cache';
import { getReport } from './report';
import { globalNoReleaseRepos } from './release-exclusions';
import type { MetricsResult, Selection } from './github/types';
import { env } from '$env/dynamic/private';

const TTL_MS = Number(env.METRICS_CACHE_TTL_MS ?? 20 * 60 * 1000);

function selectionKey(s: Selection): string {
	return JSON.stringify({
		v: 9, // bump when MetricsResult's shape or its derivation changes
		// The `!nr` suffix and the global ignore-list both change which releases are
		// counted, so two otherwise-identical selections must not share a cache entry.
		repos: s.repos.map((r) => `${r.owner}/${r.repo}${r.noReleases ? '!nr' : ''}`).sort(),
		noReleaseRepos: [...globalNoReleaseRepos()].sort(),
		// Include email (commit attribution matches on it) and tz (it changes the
		// burnout/recovery local-time classification), so a member's email or timezone
		// change isn't masked by a stale entry.
		members: s.members.map((m) => `${m.login}:${m.email ?? ''}:${m.tz ?? ''}`).sort(),
		months: s.months,
		memberMonths: s.memberMonths,
		to: s.to ?? null,
	});
}

const cache = createCache<MetricsResult>('metrics', TTL_MS);

/** Cached, concurrency-de-duplicated metrics for a selection. */
export function getMetrics(selection: Selection): Promise<MetricsResult> {
	return cache.getOrCompute(selectionKey(selection), () => getReport(selection));
}

/** Recompute a selection's metrics NOW and replace the cached entry, so a
 * user-triggered refresh doesn't have to wait out the cache TTL. */
export async function refreshMetrics(selection: Selection): Promise<MetricsResult> {
	const result = await getReport(selection);
	await cache.set(selectionKey(selection), result);
	return result;
}
