<script lang="ts">
	import { AreaChart } from 'layerchart';

	// Drop-in replacement for the old SVG Sparkline: same prop surface.
	let {
		values,
		width = 120,
		height = 32,
		stroke = 'var(--color-brand)',
		fill,
		partialLast = false,
		partialLabel = 'the current month, still in progress'
	}: {
		values: number[];
		width?: number;
		height?: number;
		stroke?: string;
		fill?: string;
		/** The final value covers a period still in progress, not a settled one. */
		partialLast?: boolean;
		partialLabel?: string;
	} = $props();

	const data = $derived(values.map((v, i) => ({ i, v })));
	// Default the area fill to a faint wash of the stroke colour.
	const fillColor = $derived(fill ?? `color-mix(in srgb, ${stroke} 14%, transparent)`);

	// Fade exactly the final segment, so the in-progress tail reads as provisional
	// without touching the settled history before it. These sparklines are ~60px
	// wide, where that fade is a hint rather than a statement, so the title carries
	// the actual explanation for anyone who stops to look.
	const lastSegmentPct = $derived(values.length > 1 ? 100 / (values.length - 1) : 0);
	const fadeMask = $derived(
		`linear-gradient(to right, #000 ${100 - lastSegmentPct}%, rgba(0,0,0,0.25) 100%)`
	);
</script>

<div
	style="width: {width}px; height: {height}px; max-width: 100%;{partialLast
		? ` -webkit-mask-image: ${fadeMask}; mask-image: ${fadeMask};`
		: ''}"
	title={partialLast ? `Final point is ${partialLabel}` : undefined}
>
	<AreaChart
		{data}
		x="i"
		y="v"
		axis={false}
		grid={false}
		legend={false}
		rule={false}
		tooltipContext={false}
		padding={{ top: 2, bottom: 2, left: 0, right: 0 }}
		series={[{ key: 'v', color: stroke }]}
		props={{
			area: {
				fill: fillColor,
				'fill-opacity': 1,
				line: { stroke, 'stroke-width': 1.5 }
			}
		}}
		class="h-full w-full"
	/>
</div>
