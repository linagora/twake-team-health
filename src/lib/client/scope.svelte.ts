// Reactive selection state: which team + window is active, plus the user's teams.
// Built-in presets come from server config. Custom teams are persisted per-user in
// Postgres when configured (private to the user), else in localStorage for dev.
// The active team + window is always a per-browser preference (localStorage).
import {
	loadTeams,
	saveTeams,
	loadScope,
	saveScope,
	newTeamId,
	DEFAULT_TEAM_ID,
	type Team
} from './selection';
import { replaceSearchParams } from './url';
import { metrics, selectionFor, redirectToSignIn } from './metrics.svelte';
import type { Member, Repo } from '$lib/server/github/types';

// A shared/bookmarked link can carry any value; cap it so a stray ?window=1e9
// can't drive an enormous metrics query.
const MAX_WINDOW = 60;

type TeamInput = { name: string; members: Member[]; repos: Repo[] };

class ScopeStore {
	teams = $state<Team[]>([]);
	activeTeamId = $state<string>(DEFAULT_TEAM_ID);
	months = $state(12);
	memberMonths = $state(3);
	initialized = $state(false);
	persisted = $state(false);
	#builtins: Team[] = [];

	get activeTeam(): Team {
		return this.teams.find((t) => t.id === this.activeTeamId) ?? this.teams[0];
	}
	get customTeams(): Team[] {
		return this.teams.filter((t) => !t.builtin);
	}

	async init(builtins: Team[], persisted: boolean, url?: URL): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		this.#builtins = builtins;
		this.persisted = persisted;

		let custom: Team[] = [];
		if (persisted) {
			try {
				const res = await fetch('/api/teams');
				if (res.status === 401) return redirectToSignIn();
				if (res.ok) custom = (await res.json()).teams.map((t: TeamInput & { id: string }) => ({ ...t, builtin: false }));
			} catch {
				/* fall back to no custom teams */
			}
		} else {
			custom = loadTeams();
		}
		this.teams = [...builtins, ...custom];

		const fallbackId = builtins[0]?.id ?? DEFAULT_TEAM_ID;
		// Default window comes from server config (set on this.months before init); use
		// it as the fallback so a first-time visitor honors DEFAULT_MONTHS/MEMBER_MONTHS.
		const s = loadScope({ teamId: fallbackId, months: this.months, memberMonths: this.memberMonths });
		// Precedence: URL query param (a shared/bookmarked link) > localStorage > config.
		const urlTeam = url?.searchParams.get('team');
		const urlMonths = Number(url?.searchParams.get('window'));
		const validUrlMonths = Number.isInteger(urlMonths) && urlMonths > 0 && urlMonths <= MAX_WINDOW;
		this.activeTeamId =
			urlTeam && this.teams.some((t) => t.id === urlTeam)
				? urlTeam
				: this.teams.some((t) => t.id === s.teamId)
					? s.teamId
					: fallbackId;
		this.months = validUrlMonths ? urlMonths : s.months;
		this.memberMonths = Math.min(s.memberMonths, this.months);
		this.#persistPrefs();
		this.syncUrl();
		this.reload();
	}

	#persistPrefs(): void {
		saveScope({ teamId: this.activeTeamId, months: this.months, memberMonths: this.memberMonths });
	}

	/** Mirror the active scope into the URL query string (replace, no history entry)
	 * so the current view is a shareable, bookmarkable link. Only writes when the
	 * search actually changes, so it is safe to call from a navigation effect. */
	syncUrl(): void {
		if (!this.initialized) return;
		replaceSearchParams((params) => {
			params.set('team', this.activeTeamId);
			params.set('window', String(this.months));
		});
	}
	#persistLocalTeams(): void {
		if (!this.persisted) saveTeams(this.teams);
	}

	reload(): void {
		const t = this.activeTeam;
		if (t?.repos.length) metrics.load(selectionFor(t, this.months, this.memberMonths));
	}

	setTeam(id: string): void {
		this.activeTeamId = id;
		this.#persistPrefs();
		this.syncUrl();
		this.reload();
	}
	setWindow(months: number, memberMonths = this.memberMonths): void {
		this.months = months;
		this.memberMonths = Math.min(memberMonths, months);
		this.#persistPrefs();
		this.syncUrl();
		this.reload();
	}

	async addTeam(input: TeamInput): Promise<void> {
		let team: Team;
		if (this.persisted) {
			const res = await fetch('/api/teams', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(input)
			});
			if (!res.ok) throw new Error(await res.text());
			team = { ...(await res.json()).team, builtin: false };
		} else {
			team = { id: newTeamId(), builtin: false, ...input };
		}
		this.teams = [...this.teams, team];
		this.activeTeamId = team.id;
		this.#persistLocalTeams();
		this.#persistPrefs();
		this.reload();
	}

	async updateTeam(id: string, input: TeamInput): Promise<void> {
		if (this.persisted) {
			const res = await fetch(`/api/teams/${id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(input)
			});
			if (!res.ok) throw new Error(await res.text());
		}
		this.teams = this.teams.map((t) => (t.id === id ? { ...t, ...input } : t));
		this.#persistLocalTeams();
		if (id === this.activeTeamId) this.reload();
	}

	async deleteTeam(id: string): Promise<void> {
		if (this.persisted) {
			const res = await fetch(`/api/teams/${id}`, { method: 'DELETE' });
			if (!res.ok && res.status !== 404) throw new Error(await res.text());
		}
		this.teams = this.teams.filter((t) => t.id !== id);
		if (this.activeTeamId === id) this.activeTeamId = this.#builtins[0]?.id ?? DEFAULT_TEAM_ID;
		this.#persistLocalTeams();
		this.#persistPrefs();
		this.reload();
	}
}

export const scope = new ScopeStore();
