import { getMetrics } from './metrics-cache';
import { getAttention } from './attention-cache';
import {
	defaultTeams,
	defaultGlobalRepos,
	defaultSelection,
	GLOBAL_MONTHS,
	DEFAULT_MONTHS,
	DEFAULT_MEMBER_MONTHS
} from './preset';
import type { Member, Repo, Selection } from './github/types';

const repoKey = (r: Repo) => `${r.owner}/${r.repo}`;
const dedupeRepos = (repos: Repo[]) => [...new Map(repos.map((r) => [repoKey(r), r])).values()];
const dedupeMembers = (members: Member[]) => [...new Map(members.map((m) => [m.login, m])).values()];

export type WarmResult = { warmed: string[]; failed: { label: string; error: string }[]; repos: number };

/**
 * Refresh the data the app serves so user requests stay warm and never trigger a
 * cold GitHub fetch. Completed months are immutable once stored, so each run only
 * refreshes the current month (shared across teams) plus any month still missing.
 * Sequential on purpose: warming must not itself burst into a secondary rate limit.
 */
export async function warmAll(): Promise<WarmResult> {
	const teams = defaultTeams();
	const globalRepos = defaultGlobalRepos();
	const allMembers = dedupeMembers(teams.flatMap((t) => t.members));
	const allRepos = dedupeRepos([...globalRepos, ...teams.flatMap((t) => t.repos)]);

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
	return { warmed, failed, repos: allRepos.length };
}
