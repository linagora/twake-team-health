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
	memberWindow,
	DEFAULT_TEAM_ID,
	type Team
} from './selection';
import { replaceSearchParams } from './url';
import { metrics, selectionFor, redirectToSignIn } from './metrics.svelte';
import { monthKeyOf, addMonths, monthList, isMonthKey } from '$lib/months';
import type { Member, Repo } from '$lib/server/github/types';

// The server clamps a window to 24 months, so the client matches it: the range
// picker caps there and a stray ?window=1e9 from a shared link is clamped too,
// keeping the displayed range length in sync with the data the server returns.
const RANGE_MAX = 24;

type TeamInput = { name: string; members: Member[]; repos: Repo[]; tz?: string };

class ScopeStore {
	teams = $state<Team[]>([]);
	activeTeamId = $state<string>(DEFAULT_TEAM_ID);
	months = $state(12);
	/** Derived from `months` (see memberWindow), never set directly: the top bar's
	 * period drives the member series the same way it drives every other surface. */
	memberMonths = $state(3);
	/** Configured shortest member window (DEFAULT_MEMBER_MONTHS), used as the floor. */
	memberMonthsFloor = $state(3);
	// End month of the window, "YYYY-MM". Empty = the current month (rolling).
	to = $state('');
	initialized = $state(false);
	persisted = $state(false);
	#builtins: Team[] = [];

	get activeTeam(): Team {
		return this.teams.find((t) => t.id === this.activeTeamId) ?? this.teams[0];
	}
	/** Effective end month of the window (current month when rolling). */
	get rangeTo(): string {
		return this.to || monthKeyOf();
	}
	/** Effective start month of the window. */
	get rangeFrom(): string {
		return addMonths(this.rangeTo, -(this.months - 1));
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
		const validUrlMonths = Number.isInteger(urlMonths) && urlMonths > 0;
		const urlTo = url?.searchParams.get('to') ?? '';
		this.activeTeamId =
			urlTeam && this.teams.some((t) => t.id === urlTeam)
				? urlTeam
				: this.teams.some((t) => t.id === s.teamId)
					? s.teamId
					: fallbackId;
		// Clamp to the server's max so the displayed range can't exceed the data.
		this.months = Math.min(Math.max(1, validUrlMonths ? urlMonths : s.months), RANGE_MAX);
		this.memberMonths = memberWindow(this.months, this.memberMonthsFloor);
		// End month: URL > localStorage > rolling (current month).
		this.to = isMonthKey(urlTo) ? urlTo : isMonthKey(s.to) ? s.to : '';
		this.#persistPrefs();
		this.syncUrl();
		this.reload();
	}

	#persistPrefs(): void {
		saveScope({
			teamId: this.activeTeamId,
			months: this.months,
			memberMonths: this.memberMonths,
			to: this.to
		});
	}

	/** Mirror the active scope into the URL query string (replace, no history entry)
	 * so the current view is a shareable, bookmarkable link. Only writes when the
	 * search actually changes, so it is safe to call from a navigation effect. */
	syncUrl(): void {
		if (!this.initialized) return;
		replaceSearchParams((params) => {
			params.set('team', this.activeTeamId);
			params.set('window', String(this.months));
			if (this.to) params.set('to', this.to);
			else params.delete('to');
		});
	}
	#persistLocalTeams(): void {
		if (!this.persisted) saveTeams(this.teams);
	}

	reload(): void {
		const t = this.activeTeam;
		if (t?.repos.length)
			metrics.load(selectionFor(t, this.months, this.memberMonths, this.to || undefined));
	}

	setTeam(id: string): void {
		this.activeTeamId = id;
		this.#persistPrefs();
		this.syncUrl();
		this.reload();
	}

	/** Set the window to an arbitrary [from, to] month range (order-independent),
	 * capped at RANGE_MAX months. A range ending at the current month stays rolling. */
	setRange(fromKey: string, toKey: string): void {
		const list = monthList(fromKey, toKey); // ascending, inclusive
		const window = list.slice(-RANGE_MAX); // cap length, keep the latest months
		const latest = window[window.length - 1];
		this.months = window.length;
		this.to = latest === monthKeyOf() ? '' : latest;
		this.memberMonths = memberWindow(this.months, this.memberMonthsFloor);
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

	/** Edit a built-in default team in place. The override is global (shared with
	 * every user) and requires server persistence, so there is no localStorage path. */
	async updateDefaultTeam(id: string, input: TeamInput): Promise<void> {
		const res = await fetch(`/api/default-teams/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input)
		});
		if (!res.ok) throw new Error(await res.text());
		const team = (await res.json()).team as Team;
		this.teams = this.teams.map((t) => (t.id === id ? team : t));
		if (id === this.activeTeamId) this.reload();
	}

	/** Clear a built-in team's override, reverting it to the env preset. */
	async resetDefaultTeam(id: string): Promise<void> {
		const res = await fetch(`/api/default-teams/${id}`, { method: 'DELETE' });
		if (!res.ok) throw new Error(await res.text());
		const team = (await res.json()).team as Team | undefined;
		if (team) this.teams = this.teams.map((t) => (t.id === id ? { ...team, builtin: true } : t));
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
