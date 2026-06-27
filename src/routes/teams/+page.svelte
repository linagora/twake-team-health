<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { scope } from '$lib/client/scope.svelte';
	import { discovery } from '$lib/client/discovery.svelte';
	import { repoKey, parseRepoKey, type Team } from '$lib/client/selection';
	import type { Member, Repo } from '$lib/server/github/types';
	import { Plus, Pencil, Trash2, Check, Users, GitBranch, Loader2, Search, Copy } from '@lucide/svelte';
	import { untrack } from 'svelte';

	let { data } = $props();

	// Teams persist server-side per user when a database is configured, otherwise
	// they fall back to this browser's localStorage. Say which one is in effect.
	// teamsPersisted is a fixed server config, so read it non-reactively.
	const persistenceNote = untrack(() => data.teamsPersisted)
		? 'Your teams are saved to your account.'
		: 'Your teams are saved in this browser.';

	$effect(() => {
		discovery.ensure();
	});

	type Draft = { id: string | null; name: string; members: Set<string>; repos: Set<string> };
	let draft = $state<Draft | null>(null);
	// A preconfigured team shown read-only in the detail panel.
	let viewing = $state<Team | null>(null);
	let memberQuery = $state('');
	let repoQuery = $state('');

	function startNew() {
		draft = { id: null, name: '', members: new Set(), repos: new Set() };
		viewing = null;
		memberQuery = '';
		repoQuery = '';
	}
	/** Open a team's members and repositories read-only (used for default teams). */
	function view(t: Team) {
		viewing = t;
		draft = null;
	}
	/** Start a new, editable team pre-filled from an existing one (clone). */
	function startFrom(t: Team) {
		draft = {
			id: null,
			name: `${t.name} copy`,
			members: new Set(t.members.map((m) => m.login)),
			repos: new Set(t.repos.map(repoKey))
		};
		viewing = null;
		memberQuery = '';
		repoQuery = '';
	}
	function startEdit(id: string) {
		const t = scope.teams.find((x) => x.id === id);
		if (!t) return;
		draft = {
			id: t.id,
			name: t.name,
			members: new Set(t.members.map((m) => m.login)),
			repos: new Set(t.repos.map(repoKey))
		};
		viewing = null;
		memberQuery = '';
		repoQuery = '';
	}
	function cancel() {
		draft = null;
	}

	const memberByLogin = $derived(new Map(discovery.members.map((m) => [m.login, m])));
	const repoByKey = $derived(new Map(discovery.repos.map((r) => [repoKey(r), r])));

	let saving = $state(false);
	let saveError = $state<string | null>(null);

	async function save() {
		if (!draft) return;
		const members: Member[] = [...draft.members].map(
			(login) => memberByLogin.get(login) ?? { login, name: login }
		);
		const repos: Repo[] = [...draft.repos].map((k) => repoByKey.get(k) ?? parseRepoKey(k));
		if (!draft.name.trim() || repos.length === 0) return;
		saving = true;
		saveError = null;
		try {
			const input = { name: draft.name.trim(), members, repos };
			if (draft.id) await scope.updateTeam(draft.id, input);
			else await scope.addTeam(input);
			draft = null;
		} catch (e) {
			saveError = (e as Error).message;
		} finally {
			saving = false;
		}
	}

	const filteredMembers = $derived(
		discovery.members
			.filter((m) => `${m.login} ${m.name}`.toLowerCase().includes(memberQuery.toLowerCase()))
			.slice(0, 200)
	);
	const filteredRepos = $derived(
		discovery.repos
			.filter((r) => repoKey(r).toLowerCase().includes(repoQuery.toLowerCase()))
			.slice(0, 200)
	);

	function toggle(which: 'members' | 'repos', key: string) {
		if (!draft) return;
		const set = draft[which];
		if (set.has(key)) set.delete(key);
		else set.add(key);
		draft = { ...draft }; // reassign to trigger reactivity
	}
</script>

<Topbar eyebrow="Teams" title="Teams." subtitle="Pick any members and repositories to build a team. {persistenceNote}" />

<div class="px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
	<div class="grid grid-cols-12 gap-8">
		<!-- Team list -->
		<div class="col-span-12 lg:col-span-4">
			<div class="mb-4 flex items-center justify-between">
				<div class="eyebrow">Your teams</div>
				<Button size="sm" onclick={startNew}><Plus class="h-3.5 w-3.5" /> New team</Button>
			</div>
			<div class="space-y-2">
				{#each scope.teams as t (t.id)}
					<Card.Root
						class="gap-0 p-4 shadow-sm cursor-pointer transition-shadow hover:shadow-md {t.id === scope.activeTeamId ? 'ring-2 ring-[var(--color-brand)]' : ''} {viewing?.id === t.id ? 'ring-2 ring-[var(--color-ink-300)]' : ''}"
						role="button"
						tabindex={0}
						onclick={() => view(t)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								view(t);
							}
						}}
					>
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<span class="font-display text-base text-[var(--color-ink-950)] truncate">{t.name}</span>
									{#if t.builtin}<span class="rounded bg-[var(--color-ink-100)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--color-ink-600)]">default</span>{/if}
								</div>
								<div class="mt-1 flex items-center gap-3 font-mono text-[11px] text-[var(--color-ink-600)]">
									<span class="inline-flex items-center gap-1"><Users class="h-3 w-3" />{t.members.length}</span>
									<span class="inline-flex items-center gap-1"><GitBranch class="h-3 w-3" />{t.repos.length}</span>
								</div>
							</div>
							<div class="flex shrink-0 items-center gap-1">
								{#if t.id === scope.activeTeamId}
									<span class="inline-flex items-center gap-1 rounded-md bg-[var(--color-brand)]/10 px-2 py-1 text-[11px] text-[var(--color-brand)]"><Check class="h-3 w-3" /> active</span>
								{:else}
									<Button size="xs" variant="outline" onclick={(e) => { e.stopPropagation(); scope.setTeam(t.id); }}>Use</Button>
								{/if}
								<Button size="icon-xs" variant="ghost" onclick={(e) => { e.stopPropagation(); startFrom(t); }} aria-label="Duplicate team">
									<Copy class="h-3.5 w-3.5" />
								</Button>
								{#if !t.builtin}
									<Button size="icon-xs" variant="ghost" onclick={(e) => { e.stopPropagation(); startEdit(t.id); }} aria-label="Edit"><Pencil class="h-3.5 w-3.5" /></Button>
									<Button size="icon-xs" variant="ghost" onclick={(e) => { e.stopPropagation(); scope.deleteTeam(t.id); }} aria-label="Delete"><Trash2 class="h-3.5 w-3.5 text-[var(--color-negative)]" /></Button>
								{/if}
							</div>
						</div>
					</Card.Root>
				{/each}
			</div>
		</div>

		<!-- Editor -->
		<div class="col-span-12 lg:col-span-8">
			{#if !draft && !viewing}
				<Card.Root class="flex h-full min-h-72 flex-col items-center justify-center gap-3 p-10 text-center shadow-sm">
					<Users class="h-9 w-9 text-[var(--color-ink-400)]" />
					<p class="text-sm text-[var(--color-ink-600)]">Select a team to edit, view a default, or create a new one.</p>
					<Button onclick={startNew}><Plus class="h-4 w-4" /> New team</Button>
				</Card.Root>
			{:else if viewing}
				<Card.Root class="gap-0 p-7 shadow-sm">
					<div class="mb-6">
						<div class="flex items-center gap-2">
							<span class="font-display text-xl text-[var(--color-ink-950)]">{viewing.name}</span>
							{#if viewing.builtin}<span class="rounded bg-[var(--color-ink-100)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--color-ink-600)]">default</span>{/if}
						</div>
						<p class="mt-1.5 text-sm text-[var(--color-ink-600)]">
							{#if viewing.builtin}A preconfigured team. Duplicate it to make your own editable copy.{:else}The members and repositories in this team.{/if}
						</p>
					</div>

					<div class="grid grid-cols-1 gap-6 md:grid-cols-2">
						<div>
							<div class="mb-2 flex items-center justify-between">
								<span class="eyebrow">Members</span>
								<span class="font-mono text-[11px] text-[var(--color-ink-600)]">{viewing.members.length}</span>
							</div>
							<div class="h-64 overflow-y-auto rounded-lg border border-[var(--color-ink-200)]">
								{#each viewing.members as m (m.login)}
									<div class="flex items-center gap-2.5 px-3 py-1.5 text-sm">
										<span class="text-[var(--color-ink-900)]">{m.name}</span>
										<span class="font-mono text-[11px] text-[var(--color-ink-500)]">{m.login}</span>
									</div>
								{:else}
									<div class="px-3 py-2 text-sm text-[var(--color-ink-500)]">No members.</div>
								{/each}
							</div>
						</div>

						<div>
							<div class="mb-2 flex items-center justify-between">
								<span class="eyebrow">Repositories</span>
								<span class="font-mono text-[11px] text-[var(--color-ink-600)]">{viewing.repos.length}</span>
							</div>
							<div class="h-64 overflow-y-auto rounded-lg border border-[var(--color-ink-200)]">
								{#each viewing.repos as r (repoKey(r))}
									<div class="flex items-center gap-2.5 px-3 py-1.5 text-sm">
										<span class="font-mono text-[12px] text-[var(--color-ink-800)]">{r.owner}/<span class="text-[var(--color-ink-950)]">{r.repo}</span></span>
									</div>
								{:else}
									<div class="px-3 py-2 text-sm text-[var(--color-ink-500)]">No repositories.</div>
								{/each}
							</div>
						</div>
					</div>

					<div class="mt-7 flex items-center gap-3 border-t border-[var(--color-ink-200)] pt-5">
						{#if viewing.id !== scope.activeTeamId}
							<Button onclick={() => viewing && scope.setTeam(viewing.id)}>Use this team</Button>
						{/if}
						<Button variant="outline" onclick={() => viewing && startFrom(viewing)}>
							<Copy class="h-4 w-4" /> Duplicate to a new team
						</Button>
						{#if viewing && !viewing.builtin}
							<Button variant="outline" onclick={() => viewing && startEdit(viewing.id)}>
								<Pencil class="h-4 w-4" /> Edit
							</Button>
						{/if}
						<Button variant="ghost" onclick={() => (viewing = null)}>Close</Button>
					</div>
				</Card.Root>
			{:else if draft}
				<Card.Root class="gap-0 p-7 shadow-sm">
					<div class="mb-6">
						<label for="team-name" class="eyebrow mb-2 block">Team name</label>
						<input
							id="team-name"
							bind:value={draft.name}
							placeholder="e.g. Backend squad"
							class="w-full max-w-md rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] px-3 py-2 text-sm focus:border-[var(--color-brand)] focus:outline-none"
						/>
					</div>

					{#if discovery.loading}
						<div class="flex items-center gap-2 py-10 text-sm text-[var(--color-ink-600)]"><Loader2 class="h-4 w-4 animate-spin text-[var(--color-brand)]" /> Loading members and repositories…</div>
					{:else if discovery.error}
						<p class="py-6 font-mono text-xs text-[var(--color-negative)]">Discovery failed: {discovery.error}</p>
					{:else}
						<div class="grid grid-cols-1 gap-6 md:grid-cols-2">
							<!-- Members -->
							<div>
								<div class="mb-2 flex items-center justify-between">
									<span class="eyebrow">Members</span>
									<span class="font-mono text-[11px] text-[var(--color-ink-600)]">{draft.members.size} selected</span>
								</div>
								<div class="relative mb-2">
									<Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-ink-500)]" />
									<input bind:value={memberQuery} placeholder="Search members" aria-label="Search members" class="w-full rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] py-1.5 pl-8 pr-3 text-sm focus:border-[var(--color-brand)] focus:outline-none" />
								</div>
								<div class="h-64 overflow-y-auto rounded-lg border border-[var(--color-ink-200)]">
									{#each filteredMembers as m (m.login)}
										<label class="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-[var(--color-ink-50)]">
											<input type="checkbox" checked={draft.members.has(m.login)} onchange={() => toggle('members', m.login)} class="accent-[var(--color-brand)]" />
											<span class="text-[var(--color-ink-900)]">{m.name}</span>
											<span class="font-mono text-[11px] text-[var(--color-ink-500)]">{m.login}</span>
										</label>
									{/each}
								</div>
							</div>

							<!-- Repos -->
							<div>
								<div class="mb-2 flex items-center justify-between">
									<span class="eyebrow">Repositories</span>
									<span class="font-mono text-[11px] text-[var(--color-ink-600)]">{draft.repos.size} selected</span>
								</div>
								<div class="relative mb-2">
									<Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-ink-500)]" />
									<input bind:value={repoQuery} placeholder="Search repositories" aria-label="Search repositories" class="w-full rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] py-1.5 pl-8 pr-3 text-sm focus:border-[var(--color-brand)] focus:outline-none" />
								</div>
								<div class="h-64 overflow-y-auto rounded-lg border border-[var(--color-ink-200)]">
									{#each filteredRepos as r (repoKey(r))}
										<label class="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-[var(--color-ink-50)]">
											<input type="checkbox" checked={draft.repos.has(repoKey(r))} onchange={() => toggle('repos', repoKey(r))} class="accent-[var(--color-brand)]" />
											<span class="font-mono text-[12px] text-[var(--color-ink-800)]">{r.owner}/<span class="text-[var(--color-ink-950)]">{r.repo}</span></span>
										</label>
									{/each}
								</div>
							</div>
						</div>
					{/if}

					<div class="mt-7 flex items-center gap-3 border-t border-[var(--color-ink-200)] pt-5">
						<Button onclick={save} disabled={saving || !draft.name.trim() || draft.repos.size === 0}>
							{saving ? 'Saving…' : draft.id ? 'Save changes' : 'Create team'}
						</Button>
						<Button variant="ghost" onclick={cancel}>Cancel</Button>
						{#if saveError}
							<span class="text-xs text-[var(--color-negative)]">{saveError}</span>
						{:else if draft.repos.size === 0}
							<span class="text-xs text-[var(--color-ink-500)]">Pick at least one repository.</span>
						{/if}
					</div>
				</Card.Root>
			{/if}
		</div>
	</div>
</div>
