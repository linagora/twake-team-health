import { env } from '$env/dynamic/private';
import { getMetrics } from './metrics-cache';
import { getAttention } from './attention-cache';
import { pruneEvents } from './store/audit';
import {
	defaultTeams,
	defaultGlobalRepos,
	defaultSelection,
	GLOBAL_MONTHS,
	DEFAULT_MONTHS,
	DEFAULT_MEMBER_MONTHS,
} from './preset';
import { getAppSettings } from './app-config';
import { computeSignals, scopeKey } from '$lib/signals';
import { upsertSignalSnapshots } from './signal-history';
import { withTeamTz } from '$lib/tz';
import type { Member, Repo, Selection } from './github/types';

const retentionEnv = Number(env.AUDIT_RETENTION_DAYS);
const AUDIT_RETENTION_DAYS = Number.isFinite(retentionEnv) && retentionEnv > 0 ? retentionEnv : 90;

const repoKey = (r: Repo) => `${r.owner}/${r.repo}`;
const dedupeRepos = (repos: Repo[]) => [...new Map(repos.map((r) => [repoKey(r), r])).values()];
const dedupeMembers = (members: Member[]) => [
	...new Map(members.map((m) => [m.login, m])).values(),
];

export type WarmResult = {
	warmed: string[];
	failed: { label: string; error: string }[];
	repos: number;
};

/**
 * Refresh the data the app serves so user requests stay warm and never trigger a
 * cold GitHub fetch. Completed months are immutable once stored, so each run only
 * refreshes the current month (shared across teams) plus any month still missing.
 * Sequential on purpose: warming must not itself burst into a secondary rate limit.
 */
export async function warmAll(): Promise<WarmResult> {
	const teams = defaultTeams();
	const globalRepos = defaultGlobalRepos();
	// Resolve each member's effective timezone (own override, else team default)
	// before deduping, so global burnout is also classified in local time.
	const allMembers = dedupeMembers(teams.flatMap((t) => withTeamTz(t.members, t.tz)));
	const allRepos = dedupeRepos([...globalRepos, ...teams.flatMap((t) => t.repos)]);
	const targets = (await getAppSettings()).signals;

	// Warm a scope's metrics, then snapshot today's metrics-derived signals (bus
	// factor, burnout, workload, recovery) for its history timeline. The snapshot is
	// best-effort and reuses the just-computed metrics, so it adds no GitHub calls.
	const warmScope = async (selection: Selection) => {
		const metrics = await getMetrics(selection);
		try {
			await upsertSignalSnapshots(
				scopeKey(selection.repos),
				computeSignals(metrics, null, null, targets),
			);
		} catch (e) {
			console.warn(`[warm] signal snapshot failed: ${(e as Error).message}`);
		}
	};

	const jobs: { label: string; run: () => Promise<unknown> }[] = [
		...teams.map((t) => ({
			label: `team:${t.name}`,
			run: () =>
				warmScope({
					repos: t.repos,
					members: withTeamTz(t.members, t.tz),
					months: DEFAULT_MONTHS,
					memberMonths: DEFAULT_MEMBER_MONTHS,
				} satisfies Selection),
		})),
		{
			label: 'global',
			run: () =>
				warmScope({
					repos: globalRepos,
					members: allMembers,
					months: GLOBAL_MONTHS,
					memberMonths: DEFAULT_MEMBER_MONTHS,
				} satisfies Selection),
		},
		{ label: 'default', run: () => warmScope(defaultSelection()) },
		{ label: 'attention', run: () => getAttention(allRepos) },
		// Event-log retention: the wide per-request log grows forever otherwise.
		// A no-op DELETE when nothing is expired, so running each pass is fine.
		{ label: 'audit-prune', run: () => pruneEvents(AUDIT_RETENTION_DAYS) },
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
