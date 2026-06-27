import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { bearerAuthorized } from '$lib/server/cron-auth';
import { getMetrics } from '$lib/server/metrics-cache';
import { getAttention } from '$lib/server/attention-cache';
import {
	defaultTeams,
	defaultGlobalRepos,
	defaultSelection,
	GLOBAL_MONTHS,
	DEFAULT_MONTHS,
	DEFAULT_MEMBER_MONTHS
} from '$lib/server/preset';
import type { Member, Repo, Selection } from '$lib/server/github/types';
import type { RequestHandler } from './$types';

const repoKey = (r: Repo) => `${r.owner}/${r.repo}`;
const dedupeRepos = (repos: Repo[]) => [...new Map(repos.map((r) => [repoKey(r), r])).values()];
const dedupeMembers = (members: Member[]) => [...new Map(members.map((m) => [m.login, m])).values()];

/**
 * Refresh the data the app serves so user requests stay warm and never trigger a
 * cold GitHub fetch. Completed months are immutable once stored, so each run only
 * refreshes the current month (shared across teams) plus any month still missing.
 *
 * Token-protected (CRON_SECRET) and meant to be hit by a scheduler, e.g.:
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/warm
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!bearerAuthorized(request.headers.get('authorization'), env.CRON_SECRET)) {
		throw error(401, 'unauthorized');
	}

	const teams = defaultTeams();
	const globalRepos = defaultGlobalRepos();
	const allMembers = dedupeMembers(teams.flatMap((t) => t.members));
	const allRepos = dedupeRepos([...globalRepos, ...teams.flatMap((t) => t.repos)]);

	// Each default team at the window its view uses, then the global trend window,
	// the built-in default selection, and the open-PR worklist. Sequential on
	// purpose: warming should not itself burst GitHub into a secondary rate limit.
	const jobs: { label: string; run: () => Promise<unknown> }[] = [
		...teams.map((t) => ({
			label: `team:${t.name}`,
			run: () =>
				getMetrics({
					repos: t.repos,
					members: t.members,
					months: DEFAULT_MONTHS,
					memberMonths: DEFAULT_MEMBER_MONTHS
				} satisfies Selection)
		})),
		{
			label: 'global',
			run: () =>
				getMetrics({
					repos: globalRepos,
					members: allMembers,
					months: GLOBAL_MONTHS,
					memberMonths: DEFAULT_MEMBER_MONTHS
				} satisfies Selection)
		},
		{ label: 'default', run: () => getMetrics(defaultSelection()) },
		{ label: 'attention', run: () => getAttention(allRepos) }
	];

	const warmed: string[] = [];
	const failed: { label: string; error: string }[] = [];
	for (const job of jobs) {
		try {
			await job.run();
			warmed.push(job.label);
		} catch (e) {
			// One failing slice (e.g. a transient rate limit) must not abort the rest.
			failed.push({ label: job.label, error: (e as Error).message });
		}
	}

	return json({ warmed, failed, repos: allRepos.length });
};
