<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import * as Card from '$lib/components/ui/card';
	import { scope } from '$lib/client/scope.svelte';
	import { attention } from '$lib/client/attention.svelte';
	import { fmtNum } from '$lib/utils';
	import { AlertCircle, Loader2, ExternalLink, CheckCircle2 } from '@lucide/svelte';
	import type { AttentionReason } from '$lib/server/github/types';

	const team = $derived(scope.activeTeam);

	// Load the worklist for the active team's repos; reload when the team changes.
	$effect(() => {
		const repos = team?.repos ?? [];
		if (repos.length) attention.ensure(repos);
	});

	const data = $derived(attention.data);

	const REASON: Record<AttentionReason, { label: string; color: string }> = {
		changes_requested: { label: 'Changes requested', color: 'var(--color-negative)' },
		unreviewed: { label: 'No review', color: 'var(--color-warning)' },
		stale: { label: 'Stale', color: 'var(--color-warning-strong)' },
		aging: { label: 'Aging', color: 'var(--color-ink-500)' },
		draft_stale: { label: 'Old draft', color: 'var(--color-ink-500)' }
	};
	const ORDER: AttentionReason[] = ['changes_requested', 'unreviewed', 'stale', 'aging', 'draft_stale'];

	let filter = $state<AttentionReason | null>(null);
	const items = $derived((data?.items ?? []).filter((it) => !filter || it.reasons.includes(filter)));

	const primaryColor = (reasons: AttentionReason[]) => {
		for (const r of ORDER) if (reasons.includes(r)) return REASON[r].color;
		return 'var(--color-ink-400)';
	};
</script>

<Topbar
	eyebrow="Attention"
	title="Where to look first"
	subtitle="Open pull requests that need a review, are blocked, or have gone quiet for {team?.name ?? 'your team'}."
/>

<div class="px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
	{#if attention.error}
		<Card.Root class="p-10 text-center shadow-sm">
			<AlertCircle class="mx-auto h-9 w-9 text-[var(--color-negative)]" />
			<p class="mt-3 font-mono text-xs text-[var(--color-ink-600)]">{attention.error}</p>
		</Card.Root>
	{:else if !data && attention.loading}
		<div class="flex items-center justify-center gap-3 py-32 text-[var(--color-ink-600)]">
			<Loader2 class="h-5 w-5 animate-spin text-[var(--color-brand)]" />
			<span class="text-sm">Scanning open pull requests…</span>
		</div>
	{:else if data}
		<!-- Filter chips -->
		<div class="mb-8 flex flex-wrap items-center gap-2">
			<button
				onclick={() => (filter = null)}
				class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors {filter === null
					? 'border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-ink-950)]'
					: 'border-[var(--color-ink-300)] text-[var(--color-ink-700)] hover:border-[var(--color-ink-400)]'}"
			>
				All <span class="font-mono tabular text-[var(--color-ink-900)]">{data.summary.total}</span>
			</button>
			{#each ORDER as r (r)}
				{#if data.summary[r] > 0}
					<button
						onclick={() => (filter = filter === r ? null : r)}
						class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors {filter === r
							? 'border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-ink-950)]'
							: 'border-[var(--color-ink-300)] text-[var(--color-ink-700)] hover:border-[var(--color-ink-400)]'}"
					>
						<span class="h-1.5 w-1.5 rounded-full" style:background-color={REASON[r].color}></span>
						{REASON[r].label} <span class="font-mono tabular text-[var(--color-ink-900)]">{data.summary[r]}</span>
					</button>
				{/if}
			{/each}
		</div>

		{#if items.length === 0}
			<Card.Root class="flex flex-col items-center gap-3 p-16 text-center shadow-sm">
				<CheckCircle2 class="h-10 w-10 text-[var(--color-positive)]" />
				<p class="text-sm text-[var(--color-ink-700)]">All clear. Nothing needs attention right now.</p>
			</Card.Root>
		{:else}
			<Card.Root class="gap-0 overflow-hidden py-0 shadow-sm">
				{#each items as it, i (it.repo + '#' + it.number)}
					<a
						href={it.url}
						target="_blank"
						rel="noopener noreferrer"
						class="group flex items-start gap-4 px-5 py-4 transition-colors hover:bg-[var(--color-ink-50)] {i !== 0
							? 'border-t border-[var(--color-ink-200)]'
							: ''}"
					>
						<span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style:background-color={primaryColor(it.reasons)}></span>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<span class="truncate text-[var(--color-ink-950)] group-hover:text-[var(--color-brand)]">{it.title}</span>
								<ExternalLink class="h-3 w-3 shrink-0 text-[var(--color-ink-400)] opacity-0 transition-opacity group-hover:opacity-100" />
							</div>
							<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-600)]">
								<span class="text-[var(--color-ink-800)]">{it.repo} #{it.number}</span>
								<span>{it.author}</span>
								<span>opened {it.ageDays}d ago</span>
								{#if it.idleDays >= 1}<span>idle {it.idleDays}d</span>{/if}
								<span>
									<span class="text-[var(--color-positive)]">+{fmtNum(it.additions)}</span>
									<span class="text-[var(--color-negative)]">−{fmtNum(it.deletions)}</span>
								</span>
							</div>
						</div>
						<div class="flex shrink-0 flex-wrap justify-end gap-1.5">
							{#each ORDER.filter((r) => it.reasons.includes(r)) as r (r)}
								<span class="inline-flex items-center gap-1 rounded-full border border-[var(--color-ink-200)] px-2 py-0.5 text-[10px] text-[var(--color-ink-700)]">
									<span class="h-1.5 w-1.5 rounded-full" style:background-color={REASON[r].color}></span>{REASON[r].label}
								</span>
							{/each}
						</div>
					</a>
				{/each}
			</Card.Root>
		{/if}
	{/if}
</div>
