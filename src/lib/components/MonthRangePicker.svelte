<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { fmtMonth } from '$lib/utils';
	import { monthKeyOf, addMonths } from '$lib/months';
	import { ChevronLeft, ChevronRight, Calendar } from '@lucide/svelte';

	// A month-granularity range picker. Click a start month, then an end month;
	// the order is normalized. Selection is bounded to the last `maxMonths` months.
	let {
		from,
		to,
		onChange,
		maxMonths = 24
	}: {
		from: string;
		to: string;
		onChange: (from: string, to: string) => void;
		maxMonths?: number;
	} = $props();

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const pad = (n: number) => String(n).padStart(2, '0');

	// Refreshed each time the picker opens, so bounds stay correct in a long-lived
	// session that crosses a month boundary.
	let currentKey = $state(monthKeyOf());
	const maxYear = $derived(Number(currentKey.slice(0, 4)));
	const earliestKey = $derived(addMonths(currentKey, -(maxMonths - 1)));
	const minYear = $derived(Number(earliestKey.slice(0, 4)));

	let open = $state(false);
	let pending = $state<string | null>(null);
	let viewYear = $state(Number(monthKeyOf().slice(0, 4)));

	const cellKey = (m: number) => `${viewYear}-${pad(m + 1)}`;
	// YYYY-MM strings compare chronologically as plain strings (zero-padded).
	const disabled = (key: string) => key < earliestKey || key > currentKey;
	const inRange = (key: string) => !pending && key >= from && key <= to;
	const isEnd = (key: string) => key === pending || (!pending && (key === from || key === to));

	function pick(key: string) {
		if (disabled(key)) return;
		if (!pending) {
			pending = key;
			return;
		}
		const [a, b] = pending <= key ? [pending, key] : [key, pending];
		pending = null;
		open = false;
		onChange(a, b);
	}
</script>

<Popover.Root
	bind:open
	onOpenChange={(o) => {
		pending = null;
		if (o) {
			currentKey = monthKeyOf(); // refresh bounds in case the month rolled over
			viewYear = Number(to.slice(0, 4)); // open on the year of the current end month
		}
	}}
>
	<Popover.Trigger
		class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] px-2.5 text-sm text-[var(--color-ink-800)] hover:border-[var(--color-ink-400)]"
	>
		<Calendar class="h-3.5 w-3.5 text-[var(--color-ink-500)]" />
		{fmtMonth(from)} <span class="text-[var(--color-ink-500)]">→</span> {fmtMonth(to)}
	</Popover.Trigger>
	<Popover.Content class="w-60">
		<div class="mb-2 flex items-center justify-between">
			<button
				class="rounded-md p-1 text-[var(--color-ink-600)] hover:bg-[var(--color-ink-100)] disabled:opacity-30"
				disabled={viewYear <= minYear}
				onclick={() => (viewYear = Math.max(minYear, viewYear - 1))}
				aria-label="Previous year"
			>
				<ChevronLeft class="h-4 w-4" />
			</button>
			<span class="font-mono text-sm tabular text-[var(--color-ink-900)]">{viewYear}</span>
			<button
				class="rounded-md p-1 text-[var(--color-ink-600)] hover:bg-[var(--color-ink-100)] disabled:opacity-30"
				disabled={viewYear >= maxYear}
				onclick={() => (viewYear = Math.min(maxYear, viewYear + 1))}
				aria-label="Next year"
			>
				<ChevronRight class="h-4 w-4" />
			</button>
		</div>
		<div class="grid grid-cols-3 gap-1">
			{#each MONTHS as label, m (label)}
				{@const key = cellKey(m)}
				<button
					onclick={() => pick(key)}
					disabled={disabled(key)}
					class="rounded-md px-2 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-30
						{isEnd(key)
						? 'bg-[var(--color-brand)] text-white'
						: inRange(key)
							? 'bg-[var(--color-brand)]/15 text-[var(--color-ink-950)]'
							: 'text-[var(--color-ink-700)] hover:bg-[var(--color-ink-100)]'}"
				>
					{label}
				</button>
			{/each}
		</div>
		<div class="mt-2 text-[11px] text-[var(--color-ink-500)]">
			{pending ? 'Pick the end month' : 'Pick a start month'}
		</div>
	</Popover.Content>
</Popover.Root>
