<script lang="ts">
	import { BarChart, LineChart, AreaChart } from 'layerchart';
	import { curveMonotoneX } from 'd3-shape';
	import * as Chart from '$lib/components/ui/chart';
	import type { ChartConfig } from '$lib/components/ui/chart';
	import { fmtMonth } from '$lib/utils';
	import { isMonthKey, monthKeyOf } from '$lib/months';
	import { printMode } from '$lib/client/print.svelte';

	type Series = { key: string; label: string; color: string };

	let {
		data,
		x = 'month',
		series,
		kind = 'line',
		seriesLayout,
		xFormat,
		legend = true,
		class: className = 'aspect-[5/3] w-full'
	}: {
		data: Record<string, unknown>[];
		x?: string;
		series: Series[];
		kind?: 'line' | 'area' | 'bar';
		seriesLayout?: 'overlap' | 'stack' | 'group';
		xFormat?: (v: unknown) => string;
		legend?: boolean;
		class?: string;
	} = $props();

	// Default x formatter: "2025-05" -> "May 25"; anything else passes through.
	const formatX = (v: unknown) =>
		xFormat ? xFormat(v) : isMonthKey(v) ? fmtMonth(v) : String(v);

	// Compact value-axis labels: 1280 -> "1.3k".
	const formatY = (v: unknown) => {
		const n = Number(v);
		if (!Number.isFinite(n)) return '';
		const abs = Math.abs(n);
		if (abs >= 1000) return `${(n / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
		return `${n}`;
	};

	// Thin out crowded x-axis labels to ~6 evenly spaced ticks.
	const xTicks = $derived.by(() => {
		const vals = data.map((d) => d[x]);
		if (vals.length <= 7) return undefined;
		const step = Math.ceil(vals.length / 6);
		return vals.filter((_, i) => i % step === 0);
	});

	// chart-style.svelte emits `--color-<key>` from each config entry's color, and
	// the series reference it via var(--color-<key>). Series keys come from data
	// (bot logins, repo/member names) and can contain characters illegal in CSS
	// custom-property names (e.g. "dependabot[bot]", names with spaces), which
	// silently drops the color. Remap to synthetic safe keys (`__s0`, `__s1`, ...)
	// for the CSS layer while keeping the originals on each row for the x-axis.
	const config = $derived(
		Object.fromEntries(series.map((s, i) => [`__s${i}`, { label: s.label, color: s.color }])) as ChartConfig
	);
	const lcSeries = $derived(
		series.map((s, i) => ({ key: `__s${i}`, label: s.label, color: `var(--color-__s${i})` }))
	);
	const safeData = $derived(
		data.map((row) => {
			const o: Record<string, unknown> = { ...row };
			series.forEach((s, i) => (o[`__s${i}`] = row[s.key]));
			return o;
		})
	);

	// The last point is the in-progress current month when the x-axis is months and
	// the final key matches this month; flag it so its partial bar isn't misread.
	const partialMonth = $derived(
		data.length > 0 && isMonthKey(data[data.length - 1]?.[x]) && data[data.length - 1]?.[x] === monthKeyOf()
	);

	const tickLabel = { class: 'fill-[var(--color-ink-600)] text-[10px]' };
	const axisProps = $derived({
		xAxis: { ticks: xTicks, format: formatX, tickLabelProps: tickLabel },
		yAxis: { ticks: 4, format: formatY, tickLabelProps: tickLabel },
		grid: { class: 'stroke-[var(--color-ink-300)]', 'stroke-dasharray': '2 4' }
	});

	// Defer the (expensive) chart render until it scrolls near the viewport, so a
	// page with many panels only draws the few that are initially visible; the rest
	// render on scroll. The placeholder keeps the same size so layout doesn't shift.
	let visible = $state(false);
	function inView(node: HTMLElement) {
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					visible = true;
					io.disconnect();
				}
			},
			{ rootMargin: '300px' }
		);
		io.observe(node);
		return { destroy: () => io.disconnect() };
	}
</script>

<div class="flex flex-col gap-3" use:inView>
	{#if legend && series.length > 1}
		<div class="flex flex-wrap items-center gap-x-5 gap-y-1.5">
			{#each series as s (s.key)}
				<span class="flex items-center gap-2">
					<span class="h-2 w-2 rounded-[2px]" style="background: {s.color}"></span>
					<span class="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-700)]">
						{s.label}
					</span>
				</span>
			{/each}
		</div>
	{/if}

	{#if visible || printMode.on}
		<Chart.Container {config} class={className}>
		{#if kind === 'bar'}
			<BarChart
				data={safeData}
				{x}
				series={lcSeries}
				seriesLayout={seriesLayout ?? 'group'}
				grid={{ y: true, x: false }}
				bandPadding={0.32}
				groupPadding={0.18}
				props={{ ...axisProps, bars: { stroke: 'none', radius: 3, rounded: 'top' } }}
			>
				{#snippet tooltip()}
					<Chart.Tooltip indicator="dot" />
				{/snippet}
			</BarChart>
		{:else if kind === 'area'}
			<AreaChart
				data={safeData}
				{x}
				series={lcSeries}
				seriesLayout={seriesLayout === 'group' ? 'overlap' : (seriesLayout ?? 'overlap')}
				grid={{ y: true, x: false }}
				props={{
					...axisProps,
					area: { curve: curveMonotoneX, 'fill-opacity': 0.14, line: { class: 'stroke-2' } }
				}}
			>
				{#snippet tooltip()}
					<Chart.Tooltip indicator="line" />
				{/snippet}
			</AreaChart>
		{:else}
			<LineChart
				data={safeData}
				{x}
				series={lcSeries}
				grid={{ y: true, x: false }}
				props={{
					...axisProps,
					spline: { curve: curveMonotoneX, class: 'stroke-2' },
					highlight: { points: { r: 3 } }
				}}
			>
				{#snippet tooltip()}
					<Chart.Tooltip indicator="line" />
				{/snippet}
			</LineChart>
		{/if}
		</Chart.Container>
	{:else}
		<div class={className} aria-hidden="true"></div>
	{/if}

	{#if partialMonth}
		<p class="text-[10px] text-[var(--color-ink-500)]">
			{fmtMonth(monthKeyOf())} is still in progress
		</p>
	{/if}
</div>
