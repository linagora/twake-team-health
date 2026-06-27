<script lang="ts">
	import MetricChart from '$lib/components/charts/MetricChart.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import { avgOver, type OrgMonth } from '$lib/charts';
	import { fmtMonth, fmtNum } from '$lib/utils';
	import { monthKeyOf } from '$lib/months';
	import { ArrowUp, ArrowDown, Minus } from '@lucide/svelte';

	// One aggregated monthly trend (org-wide or scoped); the parent decides the scope
	// and the heading copy (the panels are identical either way).
	let { trend, heading = 'How the org is shipping' }: { trend: OrgMonth[]; heading?: string } =
		$props();

	const months = $derived(trend.map((t) => t.month));

	// Neutral "compare periods" split — the user picks a month; everything before
	// it is one period, everything from it on is the other. Snap to the midpoint
	// whenever the split is unset or falls outside the current trend's range (the
	// scope can change under us), so the trigger never shows an unpickable month.
	let splitMonth = $state<string>('');
	$effect(() => {
		if (!splitMonth || !months.includes(splitMonth))
			splitMonth = months.length ? months[Math.floor(months.length / 2)] : '';
	});
	// The before/after AVERAGES exclude the in-progress current month: a month
	// that is only a few days old would otherwise count as a full data point and
	// drag the "after" average down into a false decline. (The charts still plot
	// every month; only the averaged comparison drops the partial one.)
	const complete = $derived(trend.filter((t) => t.month < monthKeyOf()));
	const before = $derived(complete.filter((t) => t.month < splitMonth));
	const after = $derived(complete.filter((t) => t.month >= splitMonth));

	type Series = { key: string; label: string; color: string };
	const PANELS: { title: string; blurb: string; kind: 'line' | 'bar'; series: Series[] }[] = [
		{ title: 'Pull requests', blurb: 'Opened vs merged across the org, per month.', kind: 'line', series: [
			{ key: 'created', label: 'Created', color: 'var(--color-chart-2)' },
			{ key: 'merged', label: 'Merged', color: 'var(--color-chart-1)' }
		] },
		{ title: 'Code volume', blurb: 'Lines added and removed across merged PRs, per month.', kind: 'bar', series: [
			{ key: 'additions', label: 'Added', color: 'var(--color-chart-3)' },
			{ key: 'deletions', label: 'Removed', color: 'var(--color-chart-4)' }
		] },
		{ title: 'Merge rate', blurb: 'Share of closed PRs that landed.', kind: 'line', series: [
			{ key: 'mergeRate', label: 'Merge rate %', color: 'var(--color-chart-1)' }
		] },
		{ title: 'Releases', blurb: 'Published releases shipped per month.', kind: 'bar', series: [
			{ key: 'releases', label: 'Releases', color: 'var(--color-chart-5)' }
		] },
		{ title: 'Time to merge', blurb: 'Median days from open to merge (weighted).', kind: 'line', series: [
			{ key: 'daysPerPr', label: 'Days / PR', color: 'var(--color-chart-3)' }
		] },
		{ title: 'PR size', blurb: 'Lines changed per merged PR (weighted).', kind: 'line', series: [
			{ key: 'linesPerPr', label: 'Lines / PR', color: 'var(--color-chart-4)' }
		] },
		{ title: 'Review load', blurb: 'Comments + reviews per PR (weighted).', kind: 'line', series: [
			{ key: 'interactionsPerPr', label: 'Interactions / PR', color: 'var(--color-chart-5)' }
		] },
		{ title: 'Bugs & issues', blurb: 'Incoming issues each month, bugs highlighted.', kind: 'bar', series: [
			{ key: 'issues', label: 'Issues', color: 'var(--color-chart-2)' },
			{ key: 'bugs', label: 'Bugs', color: 'var(--color-chart-4)' }
		] }
	];

	const COMPARE: { key: keyof OrgMonth; label: string; unit?: string; lowerIsBetter?: boolean }[] = [
		{ key: 'merged', label: 'PRs merged / mo' },
		{ key: 'churn', label: 'Lines changed / mo' },
		{ key: 'releases', label: 'Releases / mo' },
		{ key: 'daysPerPr', label: 'Days to merge', lowerIsBetter: true },
		{ key: 'linesPerPr', label: 'Lines / PR' },
		{ key: 'bugs', label: 'Bugs / mo', lowerIsBetter: true }
	];

	function pct(b: number, a: number): number {
		if (b === 0) return a === 0 ? 0 : 100;
		return ((a - b) / b) * 100;
	}
</script>

<!-- Compare periods -->
<section class="mb-12">
	<div class="mb-5 flex flex-wrap items-end justify-between gap-3">
		<div>
			<div class="eyebrow mb-2">Compare periods</div>
			<h2 class="font-display text-[1.6rem] leading-none tracking-tight">Before vs. after</h2>
		</div>
		<div class="flex items-center gap-2 text-sm text-[var(--color-ink-600)]">
			Split at
			<Select.Root type="single" bind:value={splitMonth}>
				<Select.Trigger class="h-8 min-w-[110px] bg-[var(--color-card)]">{splitMonth ? fmtMonth(splitMonth) : 'Pick'}</Select.Trigger>
				<Select.Content>
					{#each months as m (m)}<Select.Item value={m} label={fmtMonth(m)}>{fmtMonth(m)}</Select.Item>{/each}
				</Select.Content>
			</Select.Root>
		</div>
	</div>
	<div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
		{#each COMPARE as c (c.key)}
			{@const b = avgOver(before, c.key)}
			{@const a = avgOver(after, c.key)}
			{@const change = pct(b, a)}
			{@const good = c.lowerIsBetter ? change < 0 : change > 0}
			{@const flat = Math.abs(change) < 0.5}
			<Card.Root class="gap-0 p-4 shadow-sm">
				<div class="eyebrow mb-2 truncate">{c.label}</div>
				<div class="font-display tabular text-2xl leading-none text-[var(--color-ink-950)]">
					{fmtNum(a, { maximumFractionDigits: 1 })}
				</div>
				<div class="mt-2 flex items-center gap-1 text-xs">
					<span class="font-mono tabular {flat ? 'text-[var(--color-ink-500)]' : good ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}">
						{#if flat}<Minus class="inline h-3 w-3" />{:else if change > 0}<ArrowUp class="inline h-3 w-3" />{:else}<ArrowDown class="inline h-3 w-3" />{/if}
						{fmtNum(Math.abs(change), { maximumFractionDigits: 0 })}%
					</span>
					<span class="text-[var(--color-ink-500)]">vs {fmtNum(b, { maximumFractionDigits: 1 })} before</span>
				</div>
			</Card.Root>
		{/each}
	</div>
</section>

<!-- Trend panels -->
<section>
	<div class="mb-5">
		<div class="eyebrow mb-2">Monthly trends · last {trend.length} months</div>
		<h2 class="font-display text-[1.6rem] leading-none tracking-tight">{heading}</h2>
	</div>
	<div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
		{#each PANELS as p (p.title)}
			<Card.Root class="gap-0 p-6 shadow-sm">
				<div class="mb-4 border-b border-[var(--color-ink-200)] pb-3">
					<div class="font-display text-lg leading-none">{p.title}</div>
					<div class="mt-1.5 text-xs text-[var(--color-ink-600)]">{p.blurb}</div>
				</div>
				<MetricChart data={trend} x="month" series={p.series} kind={p.kind} class="aspect-[5/2] w-full" />
			</Card.Root>
		{/each}
	</div>
</section>
