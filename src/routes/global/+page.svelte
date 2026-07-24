<script lang="ts">
	import { onMount } from 'svelte';
	import Topbar from '$lib/components/Topbar.svelte';
	import Stat from '$lib/components/Stat.svelte';
	import OrgTrendView from '$lib/components/OrgTrendView.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { globalMetrics } from '$lib/client/metrics.svelte';
	import { exportPdf } from '$lib/client/print.svelte';
	import { orgTrend, hasOrgActivity, type OrgMonth } from '$lib/charts';
	import { withoutEmptyCurrentMonth } from '$lib/months';
	import { AlertCircle, Loader2, FileDown } from '@lucide/svelte';

	let { data } = $props();

	onMount(() => {
		// Global config is fixed, so don't refetch if it's already loaded (revisits).
		if (!globalMetrics.data) {
			globalMetrics.load({ repos: data.global.repos, members: [], months: data.global.months, memberMonths: 1 });
		}
	});

	// The trend runs through the in-progress month so the charts reach today, minus
	// a month nobody has touched yet: the report zero-fills it, and orgTrend would
	// plot that as 0% merge rate rather than as no data.
	const trend = $derived<OrgMonth[]>(
		withoutEmptyCurrentMonth(orgTrend(globalMetrics.data?.repos ?? []), hasOrgActivity)
	);

	// Rolling last-30-days headline for the whole org, alongside trend charts that
	// run through the in-progress month.
	const win = $derived(globalMetrics.data?.window30d ?? null);
	const pct = (cur: number, prev: number) => (prev === 0 ? 0 : ((cur - prev) / prev) * 100);
</script>

<Topbar
	eyebrow="Global"
	title="The whole picture."
	subtitle="Organization-wide delivery trends across {data.global.repos.length} repositories over {data.global.months} months."
>
	{#snippet actions()}
		{#if globalMetrics.data}
			<Button variant="outline" size="lg" onclick={exportPdf}>
				<FileDown class="h-4 w-4" /> Export PDF
			</Button>
		{/if}
	{/snippet}
</Topbar>

<div class="px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
	{#if globalMetrics.error}
		<Card.Root class="p-10 text-center shadow-sm">
			<AlertCircle class="mx-auto h-9 w-9 text-[var(--color-negative)]" />
			<p class="mt-3 font-mono text-xs text-[var(--color-ink-600)]">{globalMetrics.error}</p>
		</Card.Root>
	{:else if !globalMetrics.data && globalMetrics.loading}
		<div class="flex items-center justify-center gap-3 py-32 text-[var(--color-ink-600)]">
			<Loader2 class="h-5 w-5 animate-spin text-[var(--color-brand)]" />
			<span class="text-sm">Aggregating organization-wide metrics…</span>
		</div>
	{:else if trend.length}
		{#if win}
			<section class="mb-12 grid grid-cols-2 gap-x-6 gap-y-8 border-b border-[var(--color-ink-300)] pb-10 lg:grid-cols-4">
				<Stat label="PRs merged · last 30 days" value={win.current.merged} trend={pct(win.current.merged, win.previous.merged)} hint="vs. previous 30 days" size="lg" />
				<Stat label="PRs opened" value={win.current.created} trend={pct(win.current.created, win.previous.created)} size="md" />
				<Stat label="Issues raised" value={win.current.issues} trend={pct(win.current.issues, win.previous.issues)} size="md" />
				<Stat label="Bugs raised" value={win.current.bugs} trend={pct(win.current.bugs, win.previous.bugs)} size="md" />
			</section>
		{/if}
		<OrgTrendView {trend} />
	{/if}
</div>
