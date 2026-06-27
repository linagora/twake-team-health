<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import { repoKey, parseRepoKey } from '$lib/client/selection';
	import { Check, Loader2, AlertCircle, GitBranch, CalendarRange, Activity, TriangleAlert, Server, RefreshCw, Building2, ShieldCheck, Bug } from '@lucide/svelte';

	let { data } = $props();

	// One-shot editor: snapshot the loaded settings into form state.
	const { settings: s, repos: discoverRepos } = untrack(() => data);
	const initialKeys = s.globalRepos.map(repoKey);
	const discoverable = discoverRepos.map(repoKey);
	const repoOptions = [...new Set([...discoverable, ...initialKeys])].sort();

	let globalMonths = $state(s.globalMonths);
	let defaultMonths = $state(s.defaultMonths);
	let defaultMemberMonths = $state(s.defaultMemberMonths);
	let attentionStaleDays = $state(s.attentionStaleDays);
	let attentionAgingDays = $state(s.attentionAgingDays);
	let fetchConcurrency = $state(s.fetchConcurrency);
	let orgName = $state(s.orgName);
	let bugLabels = $state(s.bugLabels.join(', '));
	let signals = $state({ ...s.signals });
	let repoKeys = $state<string[]>([...initialKeys]);
	const admins = untrack(() => data).admins;

	let saving = $state(false);
	let saved = $state(false);
	let err = $state('');

	let refreshing = $state(false);
	let refreshMsg = $state('');

	const targetFields: { key: keyof typeof signals; label: string }[] = [
		{ key: 'firstReviewWarnH', label: 'First review within (h)' },
		{ key: 'cycleWarnH', label: 'Cycle time within (h)' },
		{ key: 'reviewedWarnPct', label: 'Review coverage above (%)' },
		{ key: 'throughputDropWarnPct', label: 'Throughput drop warns at (%)' },
		{ key: 'busShareWarnPct', label: 'Knowledge concentration at (%)' },
		{ key: 'reviewShareWarnPct', label: 'Review-load imbalance at (%)' }
	];

	const inputCls =
		'h-9 w-full rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] px-2.5 text-sm tabular transition-colors focus:border-[var(--color-brand)] focus:outline-none';

	const onsubmit = () => {
		saving = true;
		saved = false;
		err = '';
		return async ({ result, update }: { result: { type: string; data?: any }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
			saving = false;
			if (result.type === 'success' && result.data?.saved) {
				const sv = result.data.saved;
				// Reflect the normalized values the server actually stored.
				globalMonths = sv.globalMonths;
				defaultMonths = sv.defaultMonths;
				defaultMemberMonths = sv.defaultMemberMonths;
				attentionStaleDays = sv.attentionStaleDays;
				attentionAgingDays = sv.attentionAgingDays;
				fetchConcurrency = sv.fetchConcurrency;
				orgName = sv.orgName;
				bugLabels = (sv.bugLabels ?? []).join(', ');
				signals = { ...sv.signals };
				repoKeys = sv.globalRepos.map(repoKey);
				saved = true;
			} else if (result.type === 'failure') {
				err = result.data?.error ?? 'Save failed';
			} else if (result.type === 'error') {
				err = 'Save failed';
			}
			await update({ reset: false });
		};
	};

	// The repo multi-select is a custom component, so inject its value into the
	// submitted form data; the scalar fields submit natively via their name.
	const enhancer = (formEl: HTMLFormElement) =>
		enhance(formEl, ({ formData }) => {
			for (const r of repoKeys) formData.append('repos', r);
			return onsubmit();
		});

	// Separate form for the (slow) refresh action so it has its own spinner/status.
	const refreshEnhancer = (formEl: HTMLFormElement) =>
		enhance(formEl, () => {
			refreshing = true;
			refreshMsg = '';
			return async ({ result, update }: { result: { type: string; data?: any }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
				refreshing = false;
				if (result.type === 'success' && result.data?.refresh?.started) {
					refreshMsg = 'Refresh started — data is warming in the background.';
				} else {
					refreshMsg = `Refresh failed: ${result.data?.error ?? result.type}`;
				}
				await update({ reset: false });
			};
		});
</script>

<Topbar
	eyebrow="Settings"
	title="App configuration"
	subtitle="Org-wide defaults and thresholds, editable without a redeploy. Empty values fall back to the environment configuration."
/>

<form method="POST" action="?/save" use:enhancer>
	<div class="mx-auto max-w-3xl space-y-5 px-4 pb-28 pt-6 sm:px-6 lg:px-10 lg:pt-10">
		<!-- General -->
		<Card.Root class="gap-0 p-6 shadow-sm">
			<div class="flex items-center gap-2.5">
				<Building2 class="h-4 w-4 text-[var(--color-brand)]" />
				<h2 class="font-display text-lg leading-none">General</h2>
			</div>
			<p class="mt-1.5 text-xs text-[var(--color-ink-600)]">Shown in the sidebar under the app name.</p>
			<div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
				<label class="block">
					<span class="eyebrow mb-2 block">Organization name</span>
					<input class={inputCls} type="text" name="orgName" maxlength="60" placeholder="Engineering metrics" bind:value={orgName} />
				</label>
			</div>
		</Card.Root>

		<!-- Scope -->
		<Card.Root class="gap-0 p-6 shadow-sm">
			<div class="flex items-center gap-2.5">
				<GitBranch class="h-4 w-4 text-[var(--color-brand)]" />
				<h2 class="font-display text-lg leading-none">Global scope</h2>
			</div>
			<p class="mt-1.5 text-xs text-[var(--color-ink-600)]">Repositories aggregated in the Global trends view.</p>
			<div class="mt-4">
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
		</Card.Root>

		<!-- Time windows -->
		<Card.Root class="gap-0 p-6 shadow-sm">
			<div class="flex items-center gap-2.5">
				<CalendarRange class="h-4 w-4 text-[var(--color-brand)]" />
				<h2 class="font-display text-lg leading-none">Time windows</h2>
			</div>
			<p class="mt-1.5 text-xs text-[var(--color-ink-600)]">Default ranges new visitors see, in months.</p>
			<div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
				<label class="block">
					<span class="eyebrow mb-2 block">Global window</span>
					<input class={inputCls} type="number" name="globalMonths" min="1" max="36" bind:value={globalMonths} />
				</label>
				<label class="block">
					<span class="eyebrow mb-2 block">Default window</span>
					<input class={inputCls} type="number" name="defaultMonths" min="1" max="36" bind:value={defaultMonths} />
				</label>
				<label class="block">
					<span class="eyebrow mb-2 block">Member window</span>
					<input class={inputCls} type="number" name="defaultMemberMonths" min="1" max="36" bind:value={defaultMemberMonths} />
				</label>
			</div>
		</Card.Root>

		<!-- Health targets -->
		<Card.Root class="gap-0 p-6 shadow-sm">
			<div class="flex items-center gap-2.5">
				<Activity class="h-4 w-4 text-[var(--color-brand)]" />
				<h2 class="font-display text-lg leading-none">Health targets</h2>
			</div>
			<p class="mt-1.5 text-xs text-[var(--color-ink-600)]">The "good vs needs attention" lines on the Signals page.</p>
			<div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
				{#each targetFields as f (f.key)}
					<label class="block">
						<span class="eyebrow mb-2 block">{f.label}</span>
						<input class={inputCls} type="number" name={`signal.${f.key}`} min="0" bind:value={signals[f.key]} />
					</label>
				{/each}
			</div>
		</Card.Root>

		<!-- Attention windows -->
		<Card.Root class="gap-0 p-6 shadow-sm">
			<div class="flex items-center gap-2.5">
				<TriangleAlert class="h-4 w-4 text-[var(--color-brand)]" />
				<h2 class="font-display text-lg leading-none">Attention windows</h2>
			</div>
			<p class="mt-1.5 text-xs text-[var(--color-ink-600)]">When an open PR is flagged stale or aging.</p>
			<div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
				<label class="block">
					<span class="eyebrow mb-2 block">PR stale after (days)</span>
					<input class={inputCls} type="number" name="attentionStaleDays" min="1" max="365" bind:value={attentionStaleDays} />
				</label>
				<label class="block">
					<span class="eyebrow mb-2 block">PR aging after (days)</span>
					<input class={inputCls} type="number" name="attentionAgingDays" min="1" max="365" bind:value={attentionAgingDays} />
				</label>
			</div>
		</Card.Root>

		<!-- Issue classification -->
		<Card.Root class="gap-0 p-6 shadow-sm">
			<div class="flex items-center gap-2.5">
				<Bug class="h-4 w-4 text-[var(--color-brand)]" />
				<h2 class="font-display text-lg leading-none">Bug labels</h2>
			</div>
			<p class="mt-1.5 text-xs text-[var(--color-ink-600)]">
				Issue labels that count as bugs (comma-separated). Empty = auto-detect any "bug" label. Changes
				apply to newly-fetched data; rebuilding history needs a full re-fetch.
			</p>
			<div class="mt-4">
				<input class={inputCls} type="text" name="bugLabels" placeholder="bug, type: bug, kind/bug" bind:value={bugLabels} />
			</div>
		</Card.Root>

		<!-- Fetching -->
		<Card.Root class="gap-0 p-6 shadow-sm">
			<div class="flex items-center gap-2.5">
				<Server class="h-4 w-4 text-[var(--color-brand)]" />
				<h2 class="font-display text-lg leading-none">Fetching</h2>
			</div>
			<p class="mt-1.5 text-xs text-[var(--color-ink-600)]">
				Max simultaneous GitHub calls. Lower is gentler on the rate limit; raise it for speed.
			</p>
			<div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
				<label class="block">
					<span class="eyebrow mb-2 block">Fetch concurrency (1–32)</span>
					<input class={inputCls} type="number" name="fetchConcurrency" min="1" max="32" bind:value={fetchConcurrency} />
				</label>
			</div>
		</Card.Root>
	</div>

	<!-- Sticky save bar -->
	<div class="sticky bottom-0 border-t border-[var(--color-ink-200)] bg-[var(--color-ink-0)]/85 backdrop-blur-xl">
		<div class="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 sm:px-6 lg:px-10">
			<Button type="submit" disabled={saving} size="lg">
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
			<span class="ml-auto text-[11px] text-[var(--color-ink-500)]">Saved values are normalized (clamped & allowlisted).</span>
		</div>
	</div>
</form>

<!-- Maintenance (separate action; forms can't nest) -->
<div class="mx-auto max-w-3xl px-4 pb-28 sm:px-6 lg:px-10">
	<Card.Root class="gap-0 p-6 shadow-sm">
		<div class="flex items-center gap-2.5">
			<RefreshCw class="h-4 w-4 text-[var(--color-brand)]" />
			<h2 class="font-display text-lg leading-none">Maintenance</h2>
		</div>
		<p class="mt-1.5 text-xs text-[var(--color-ink-600)]">
			Re-fetch the current month and any missing months for the default teams and Global view.
		</p>
		<form method="POST" action="?/refresh" use:refreshEnhancer class="mt-4 flex items-center gap-3">
			<Button type="submit" variant="outline" disabled={refreshing}>
				{#if refreshing}<Loader2 class="h-4 w-4 animate-spin" />{:else}<RefreshCw class="h-4 w-4" />{/if}
				Refresh data now
			</Button>
			{#if refreshMsg}
				<span class="inline-flex items-center gap-1.5 text-sm text-[var(--color-ink-700)]">
					<Check class="h-4 w-4 text-[var(--color-positive)]" /> {refreshMsg}
				</span>
			{/if}
		</form>
	</Card.Root>

	<!-- Access (read-only; admins are bootstrapped via env) -->
	<Card.Root class="mt-5 gap-0 p-6 shadow-sm">
		<div class="flex items-center gap-2.5">
			<ShieldCheck class="h-4 w-4 text-[var(--color-brand)]" />
			<h2 class="font-display text-lg leading-none">Access</h2>
		</div>
		<p class="mt-1.5 text-xs text-[var(--color-ink-600)]">
			Admins (Settings + Logs). Managed via the <code class="font-mono">ADMINS</code> environment variable.
		</p>
		<div class="mt-4 flex flex-wrap gap-2">
			{#if admins.length}
				{#each admins as a (a)}
					<span class="rounded-md bg-[var(--color-ink-100)] px-2.5 py-1 font-mono text-xs text-[var(--color-ink-800)]">{a}</span>
				{/each}
			{:else}
				<span class="text-sm text-[var(--color-ink-600)]">None configured (auth-disabled dev grants admin to everyone).</span>
			{/if}
		</div>
	</Card.Root>
</div>
