import { env } from '$env/dynamic/private';
import type { Selection, Member, Repo } from './github/types';
import { DEFAULT_TEAM_ID, type Team } from '$lib/client/selection';
import { isValidTimeZone, withTeamTz } from '$lib/tz';
import { hasDb } from './db';
import { listDefaultTeamOverrides, type DefaultTeamOverride } from './store/default-teams';

// The default team is CONFIGURATION, not source: set DEFAULT_TEAM to a JSON blob
// ({ name, members:[{login,name,email?}], repos:[{owner,repo}] }) so the team can
// be reshuffled at deploy time without a code change. The values below are only a
// fallback for local/dev when the env var is unset.
const FALLBACK_MEMBERS: Member[] = [{ login: 'octocat', name: 'The Octocat' }];

const FALLBACK_REPOS: Repo[] = [{ owner: 'octocat', repo: 'Hello-World' }];

type RawTeam = { name?: string; members?: Member[]; repos?: Repo[]; tz?: string };

function parseEnvTeams(): RawTeam[] | null {
	if (!env.DEFAULT_TEAMS) return null;
	try {
		const parsed = JSON.parse(env.DEFAULT_TEAMS);
		const arr = Array.isArray(parsed) ? parsed : [parsed];
		return arr
			.filter((t) => t && Array.isArray(t.repos))
			.map((t) => ({
				name: typeof t.name === 'string' ? t.name : undefined,
				members: Array.isArray(t.members) ? t.members : [],
				repos: (t.repos as unknown[]).map(parseRepoRef).filter((r): r is Repo => !!r),
				tz: isValidTimeZone(t.tz) ? t.tz : undefined
			}))
			// Drop teams left with no parseable repos (the guard is on real repos, not
			// the raw count, so a team of all-malformed entries doesn't become repos:[]).
			.filter((t) => t.repos.length > 0);
	} catch {
		return null;
	}
}

/** Configured shared default teams (env DEFAULT_TEAMS JSON array, else one fallback).
 * Read-only presets sent to every client. */
export function defaultTeams(): Team[] {
	const raw = parseEnvTeams();
	if (!raw || raw.length === 0) {
		return [
			{ id: DEFAULT_TEAM_ID, name: 'Default team', members: FALLBACK_MEMBERS, repos: FALLBACK_REPOS, builtin: true }
		];
	}
	return raw.map((t, i) => ({
		id: `builtin:${i}`,
		name: t.name ?? `Default team ${i + 1}`,
		members: t.members ?? [],
		repos: t.repos ?? [],
		...(t.tz ? { tz: t.tz } : {}),
		builtin: true
	}));
}

/** Overlay stored global overrides onto the env presets (pure). An override
 * replaces its preset entirely, matched by built-in id, and marks the team
 * `overridden` so the UI can offer a reset. Presets without an override stand. */
export function applyDefaultTeamOverrides(presets: Team[], overrides: Map<string, DefaultTeamOverride>): Team[] {
	if (overrides.size === 0) return presets;
	return presets.map((t) => {
		const o = overrides.get(t.id);
		if (!o) return t;
		return { id: t.id, name: o.name, members: o.members, repos: o.repos, ...(o.tz ? { tz: o.tz } : {}), builtin: true, overridden: true };
	});
}

// The layout load resolves default teams on every SSR request, so cache the
// merged result behind a short TTL (mirrors app-config's cache: accepts up to the
// TTL of cross-replica staleness). Writers clear it in-process via the exported
// helper so the editing replica sees its own change immediately.
const TEAMS_TTL_MS = 60_000;
let teamsCache: { value: Team[]; expires: number } | null = null;

/** Drop the resolved-default-teams cache so the next read reflects a just-written
 * override. Call after upserting/deleting an override. */
export function clearDefaultTeamsCache(): void {
	teamsCache = null;
}

/** Effective default teams: env presets with any stored global overrides applied.
 * Falls back to the pure env presets when no DB is configured or the read fails,
 * so a transient DB outage can't blank out the default teams. */
export async function resolveDefaultTeams(): Promise<Team[]> {
	const presets = defaultTeams();
	if (!hasDb()) return presets;
	if (teamsCache && teamsCache.expires > Date.now()) return teamsCache.value;
	try {
		const value = applyDefaultTeamOverrides(presets, await listDefaultTeamOverrides());
		teamsCache = { value, expires: Date.now() + TEAMS_TTL_MS };
		return value;
	} catch {
		return presets; // not cached, so a recovered DB is picked up on the next call
	}
}

export const DEFAULT_MONTHS = Number(env.DEFAULT_MONTHS ?? 12);
export const DEFAULT_MEMBER_MONTHS = Number(env.DEFAULT_MEMBER_MONTHS ?? 3);
// Window for the org-wide trend view; matches the per-team window by default.
export const GLOBAL_MONTHS = Number(env.GLOBAL_MONTHS ?? 12);

function parseRepoRef(r: unknown): Repo | null {
	if (typeof r === 'string' && r.includes('/')) {
		const [owner, ...rest] = r.split('/');
		return { owner, repo: rest.join('/') };
	}
	if (r && typeof r === 'object') {
		const o = r as Record<string, unknown>;
		if (typeof o.owner === 'string' && typeof o.repo === 'string')
			return { owner: o.owner, repo: o.repo, ...(o.noReleases === true ? { noReleases: true } : {}) };
	}
	return null;
}

/** Repos for the org-wide Global view. From env GLOBAL_REPOS (JSON array of
 * "owner/repo" or {owner,repo}); else the union of all preset teams' repos. */
export function defaultGlobalRepos(): Repo[] {
	if (env.GLOBAL_REPOS) {
		try {
			const arr = JSON.parse(env.GLOBAL_REPOS);
			const repos = (Array.isArray(arr) ? arr : []).map(parseRepoRef).filter((r): r is Repo => !!r);
			if (repos.length) return dedupeRepos(repos);
		} catch {
			/* fall through to union of presets */
		}
	}
	return dedupeRepos(defaultTeams().flatMap((t) => t.repos));
}

function dedupeRepos(repos: Repo[]): Repo[] {
	const seen = new Map<string, Repo>();
	for (const r of repos) {
		const key = `${r.owner}/${r.repo}`;
		// If any copy of a repo excludes releases, the deduped entry does too.
		const noReleases = r.noReleases || seen.get(key)?.noReleases;
		seen.set(key, { owner: r.owner, repo: r.repo, ...(noReleases ? { noReleases: true } : {}) });
	}
	return [...seen.values()].sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`));
}

export function defaultSelection(): Selection {
	const t = defaultTeams()[0];
	// Resolve member timezones (own override, else the team default) so the default
	// selection classifies burnout in local time, matching the per-team page.
	return { repos: t.repos, members: withTeamTz(t.members, t.tz), months: DEFAULT_MONTHS, memberMonths: DEFAULT_MEMBER_MONTHS };
}
