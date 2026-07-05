import { defineCache } from './cache';
import { getFlowReport } from './flow';
import type { FlowResult, Repo } from './github/types';
import { env } from '$env/dynamic/private';

const TTL_MS = Number(env.FLOW_CACHE_TTL_MS ?? 30 * 60 * 1000);

// Bump when FlowResult's shape changes so a deploy doesn't serve an old-shape
// cached value (missing new fields) for the rest of the TTL.
const SCHEMA = 3; // v3: flow served from the fact store
const flowKey = (repos: Repo[], months: number, to?: string): string =>
	JSON.stringify({
		v: SCHEMA,
		repos: repos.map((r) => `${r.owner}/${r.repo}`).sort(),
		months,
		to: to ?? null,
	});

/** Cached cycle-time + review-health report for a repo set over a window of
 * `months` ending at `to` (or the current month when omitted). */
export const getFlow = defineCache<[Repo[], number, string?], FlowResult>(
	'flow',
	TTL_MS,
	flowKey,
	(repos, months, to) => getFlowReport(repos, months, to),
);
