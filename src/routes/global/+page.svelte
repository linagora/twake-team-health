<script lang="ts">
	import { onMount } from 'svelte';
	import Topbar from '$lib/components/Topbar.svelte';
	import OrgTrendView from '$lib/components/OrgTrendView.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { globalMetrics } from '$lib/client/metrics.svelte';
	import { exportPdf } from '$lib/client/print.svelte';
	import { orgTrend, type OrgMonth } from '$lib/charts';
	import { AlertCircle, Loader2, FileDown } from '@lucide/svelte';

	let { data } = $props();

	onMount(() => {
		// Global config is fixed, so don't refetch if it's already loaded (revisits).
		if (!globalMetrics.data) {
			globalMetrics.load({ repos: data.global.repos, members: [], months: data.global.months, memberMonths: 1 });
		}
	});

	const trend = $derived<OrgMonth[]>(globalMetrics.data ? orgTrend(globalMetrics.data.repos) : []);
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
		<OrgTrendView {trend} />
	{/if}
</div>
