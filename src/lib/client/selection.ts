// Client-side selection + custom-team storage (localStorage, per browser).
// Nothing here touches the server's disk; teams are personal to each user.
import type { Member, Repo } from '$lib/server/github/types';

export type Team = {
	id: string;
	name: string;
	members: Member[];
	repos: Repo[];
	builtin?: boolean;
};

export type Scope = {
	teamId: string;
	months: number;
	memberMonths: number;
};

const TEAMS_KEY = 'team-health:teams';
const SCOPE_KEY = 'team-health:scope';

export const DEFAULT_TEAM_ID = 'builtin:default';

export function repoKey(r: Repo): string {
	return `${r.owner}/${r.repo}`;
}

export function parseRepoKey(key: string): Repo {
	const [owner, ...rest] = key.split('/');
	return { owner, repo: rest.join('/') };
}

/** Decode a comma-separated query-param value into a trimmed, non-empty list. */
export function parseList(s: string | null): string[] {
	return (s ?? '')
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean);
}

/** Custom teams the user has saved (excludes built-ins). */
export function loadTeams(): Team[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const raw = localStorage.getItem(TEAMS_KEY);
		return raw ? (JSON.parse(raw) as Team[]) : [];
	} catch {
		return [];
	}
}

export function saveTeams(teams: Team[]): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(TEAMS_KEY, JSON.stringify(teams.filter((t) => !t.builtin)));
}

export function loadScope(fallback: Scope): Scope {
	if (typeof localStorage === 'undefined') return fallback;
	try {
		const raw = localStorage.getItem(SCOPE_KEY);
		return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<Scope>) } : fallback;
	} catch {
		return fallback;
	}
}

export function saveScope(scope: Scope): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(SCOPE_KEY, JSON.stringify(scope));
}

let idCounter = 0;
export function newTeamId(): string {
	idCounter += 1;
	// Random/Date-free unique-enough id for a client list.
	return `team:${idCounter}:${loadTeams().length}:${performance.now().toString(36).replace('.', '')}`;
}
