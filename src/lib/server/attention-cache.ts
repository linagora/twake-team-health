import { createCache } from './cache';
import { getAttentionReport } from './attention';
import type { AttentionResult, Repo } from './github/types';
import { env } from '$env/dynamic/private';

// Open PRs change often, so this is a short-lived cache, not the monthly store.
const TTL_MS = Number(env.ATTENTION_CACHE_TTL_MS ?? 10 * 60 * 1000);

const keyOf = (repos: Repo[]) => JSON.stringify(repos.map((r) => `${r.owner}/${r.repo}`).sort());

const cache = createCache<AttentionResult>('attention', TTL_MS);

/** Cached, concurrency-de-duplicated open-PR worklist for a repo set. */
export function getAttention(repos: Repo[]): Promise<AttentionResult> {
	return cache.getOrCompute(keyOf(repos), () => getAttentionReport(repos));
}

/** Recompute NOW and replace the cached entry (user-triggered refresh). */
export async function refreshAttention(repos: Repo[]): Promise<AttentionResult> {
	const result = await getAttentionReport(repos);
	await cache.set(keyOf(repos), result);
	return result;
}
