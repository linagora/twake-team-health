<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { untrack } from 'svelte';
	import { repoKey, parseRepoKey } from '$lib/client/selection';
	import { Check, Loader2, AlertCircle } from '@lucide/svelte';

	let { data } = $props();

	// One-shot editor: snapshot the loaded settings into form state (the page
	// reloads on navigation), so read the prop non-reactively via untrack.
	const { settings: s, repos: discoverRepos } = untrack(() => data);
	const initialKeys = s.globalRepos.map(repoKey);
	const discoverable = discoverRepos.map(repoKey);

	let globalMonths = $state(s.globalMonths);
	let defaultMonths = $state(s.defaultMonths);
	let defaultMemberMonths = $state(s.defaultMemberMonths);
	let repoKeys = $state<string[]>([...initialKeys]);

	let saving = $state(false);
	let saved = $state(false);
	let err = $state('');

	// Options = everything discoverable plus anything already selected (so a repo
	// configured before it left discovery still shows).
	const repoOptions = [...new Set([...discoverable, ...initialKeys])].sort();

	const windowFields = [
		{ label: 'Global window (months)', get: () => globalMonths, set: (v: number) => (globalMonths = v) },
		{ label: 'Default window (months)', get: () => defaultMonths, set: (v: number) => (defaultMonths = v) },
		{ label: 'Member window (months)', get: () => defaultMemberMonths, set: (v: number) => (defaultMemberMonths = v) }
	];

	async function save() {
		saving = true;
		saved = false;
		err = '';
		const res = await fetch('/api/config', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				globalRepos: repoKeys.map(parseRepoKey),
				globalMonths,
				defaultMonths,
				defaultMemberMonths
			})
		});
		saving = false;
		if (res.ok) saved = true;
		else err = `${res.status}: ${(await res.text()).slice(0, 200)}`;
	}
</script>

<Topbar eyebrow="Settings" title="App configuration" subtitle="Org-wide defaults, editable without a redeploy. Empty values fall back to the environment configuration." />

<div class="max-w-2xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
	<Card.Root class="gap-6 p-6 shadow-sm">
		<!-- Global repos -->
		<div>
			<div class="font-display text-lg leading-none">Global repositories</div>
			<div class="mt-1.5 text-xs text-[var(--color-ink-600)]">Repositories aggregated in the Global view.</div>
			<div class="mt-3">
				<Select.Root type="multiple" bind:value={repoKeys}>
					<Select.Trigger class="h-9 w-full bg-[var(--color-card)]">
						{repoKeys.length ? `${repoKeys.length} repositories selected` : 'Select repositories'}
					</Select.Trigger>
					<Select.Content class="max-h-72">
						{#each repoOptions as key (key)}
							<Select.Item value={key} label={key}>{key}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
		</div>

		<!-- Windows -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
			{#each windowFields as f (f.label)}
				<label class="block">
					<span class="eyebrow mb-2 block">{f.label}</span>
					<input
						type="number"
						min="1"
						max="36"
						value={f.get()}
						oninput={(e) => f.set(Number(e.currentTarget.value))}
						class="h-9 w-full rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] px-2.5 text-sm tabular"
					/>
				</label>
			{/each}
		</div>

		<div class="flex items-center gap-3 border-t border-[var(--color-ink-200)] pt-4">
			<Button onclick={save} disabled={saving} size="lg">
				{#if saving}<Loader2 class="h-4 w-4 animate-spin" />{/if} Save changes
			</Button>
			{#if saved}
				<span class="inline-flex items-center gap-1.5 text-sm text-[var(--color-positive)]">
					<Check class="h-4 w-4" /> Saved
				</span>
			{/if}
			{#if err}
				<span class="inline-flex items-center gap-1.5 font-mono text-xs text-[var(--color-negative)]">
					<AlertCircle class="h-4 w-4" /> {err}
				</span>
			{/if}
		</div>
	</Card.Root>
</div>
