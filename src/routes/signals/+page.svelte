<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import * as Card from '$lib/components/ui/card';
	import { metrics } from '$lib/client/metrics.svelte';
	import { flow } from '$lib/client/flow.svelte';
	import { attention } from '$lib/client/attention.svelte';
	import { scope } from '$lib/client/scope.svelte';
	import { computeSignals, DEFAULT_TARGETS, type SignalLevel } from '$lib/signals';
	import { AlertCircle, AlertTriangle, ArrowRight, CheckCircle2, Loader2, TrendingUp, TrendingDown, Minus } from '@lucide/svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import MiniAreaChart from '$lib/components/charts/MiniAreaChart.svelte';
	import { page } from '$app/state';

	// Trend direction reads as a verdict, not raw slope: "better" is always the
	// green up-arrow even for metrics where the underlying number fell (e.g. latency).
	const trendColor = (dir: 'better' | 'worse' | 'flat') =>
		dir === 'better' ? 'var(--color-positive)' : dir === 'worse' ? 'var(--color-negative)' : 'var(--color-ink-400)';
	const trendIcon = (dir: 'better' | 'worse' | 'flat') =>
		dir === 'better' ? TrendingUp : dir === 'worse' ? TrendingDown : Minus;

	const team = $derived(scope.activeTeam);
	// Admin-configurable health targets (falls back to defaults).
	const targets = $derived(page.data.signals ?? DEFAULT_TARGETS);

	// Signals draw on flow + attention (and the scope-driven metrics); ensure the
	// two route-specific sources are loaded for the active team.
	$effect(() => {
		const t = scope.activeTeam;
		if (t?.repos.length) {
			flow.ensure(t.repos, scope.months, scope.to || undefined);
			attention.ensure(t.repos);
		}
	});

	const ready = $derived(!!(flow.data && attention.data));
	const loading = $derived(!ready && (flow.loading || attention.loading || metrics.loading));
	const error = $derived(flow.error || attention.error);

	const signals = $derived(
		ready ? computeSignals(metrics.data, flow.data, attention.data, targets) : []
	);
	const problems = $derived(signals.filter((s) => s.level !== 'ok'));
	const passing = $derived(signals.filter((s) => s.level === 'ok'));

	// amber-700, not amber-600: the value text needs >= 4.5:1 contrast on the card.
	const accent: Record<SignalLevel, string> = {
		bad: 'var(--color-negative)',
		warn: '#b45309',
		ok: 'var(--color-positive)'
	};
</script>

<Topbar
	eyebrow="Signals"
	title="What needs attention."
	subtitle="Automated checks across delivery, review health, and the open-PR backlog for {team?.name ?? 'your team'}."
/>

<div class="px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
	{#if error}
		<Card.Root class="p-10 text-center shadow-sm">
			<AlertCircle class="mx-auto h-9 w-9 text-[var(--color-negative)]" />
			<p class="mt-3 font-mono text-xs text-[var(--color-ink-600)]">{error}</p>
		</Card.Root>
	{:else if loading}
		<div class="flex items-center justify-center gap-3 py-32 text-[var(--color-ink-600)]">
			<Loader2 class="h-5 w-5 animate-spin text-[var(--color-brand)]" />
			<span class="text-sm">Running checks…</span>
		</div>
	{:else if ready}
		{#if problems.length === 0}
			<Card.Root class="flex flex-col items-center gap-3 p-12 text-center shadow-sm">
				<CheckCircle2 class="h-10 w-10 text-[var(--color-positive)]" />
				<p class="font-display text-xl">All clear.</p>
				<p class="text-sm text-[var(--color-ink-600)]">
					Every check is within target for {team?.name ?? 'this team'}.
				</p>
			</Card.Root>
		{:else}
			<div class="mb-3 flex items-baseline gap-2">
				<span class="font-display text-lg">{problems.length}</span>
				<span class="text-sm text-[var(--color-ink-600)]">
					{problems.length === 1 ? 'check needs' : 'checks need'} attention
				</span>
			</div>
			<div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
				{#each problems as s (s.id)}
					<Card.Root
						class="gap-0 border p-5 shadow-sm"
						style="border-left: 4px solid {accent[s.level]}; border-color: color-mix(in oklab, {accent[s.level]} 28%, var(--color-ink-200)); background: color-mix(in oklab, {accent[s.level]} 8%, var(--color-card))"
					>
						<div class="flex items-start justify-between gap-4">
							<div class="min-w-0">
								<div class="flex flex-wrap items-center gap-2">
									{#if s.level === 'bad'}
										<AlertCircle class="h-4 w-4 shrink-0" style="color: {accent[s.level]}" />
									{:else}
										<AlertTriangle class="h-4 w-4 shrink-0" style="color: {accent[s.level]}" />
									{/if}
									<span class="font-display text-base text-[var(--color-ink-950)]">{s.title}</span>
								</div>
								<p class="mt-2 text-sm leading-relaxed text-[var(--color-ink-700)]">{s.detail}</p>
								{#if s.people?.length}
									<div class="mt-2.5 flex flex-col gap-1.5">
										{#each s.people as p (p.login + p.note)}
											<a
												href="/people/{p.login}"
												class="inline-flex items-center gap-2 text-sm text-[var(--color-ink-800)] hover:text-[var(--color-brand)]"
											>
												<Avatar login={p.login} name={p.login} size={22} />
												<span class="font-medium hover:underline">{p.login}</span>
												<span class="text-[var(--color-ink-500)]">{p.note}</span>
											</a>
										{/each}
									</div>
								{/if}
								{#if s.link}
									<a
										href={s.link.href}
										class="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand)] hover:underline"
									>
										{s.link.label}
										<ArrowRight class="h-3.5 w-3.5" />
									</a>
								{/if}
							</div>
							<div class="shrink-0 text-right">
								<div class="font-mono text-xl font-semibold tabular" style="color: {accent[s.level]}">{s.value}</div>
								<div class="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-500)]">
									target {s.target}
								</div>
								{#if s.trend}
									{@const Icon = trendIcon(s.trend.dir)}
									<div class="mt-2 flex items-center justify-end gap-1.5" title="vs recent months">
										<!-- Neutral stroke: the line shows the raw metric shape; the arrow alone
										     carries the better/worse verdict (a falling latency is good but slopes down). -->
										<MiniAreaChart values={s.trend.points} width={60} height={18} stroke="var(--color-ink-400)" />
										<Icon class="h-3.5 w-3.5 shrink-0" style="color: {trendColor(s.trend.dir)}" />
									</div>
								{/if}
							</div>
						</div>
					</Card.Root>
				{/each}
			</div>
		{/if}

		{#if passing.length}
			<div class="mt-8">
				<div class="eyebrow mb-3">Passing checks</div>
				<div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
					{#each passing as s (s.id)}
						<div class="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-ink-200)] px-3 py-2">
							<span class="flex items-center gap-2 text-sm text-[var(--color-ink-700)]">
								<CheckCircle2 class="h-3.5 w-3.5 text-[var(--color-positive)]" />
								{s.title}
							</span>
							<span class="flex items-center gap-1.5 font-mono text-xs tabular text-[var(--color-ink-600)]">
								{#if s.trend}
									{@const Icon = trendIcon(s.trend.dir)}
									<span title="vs recent months" class="inline-flex"><Icon class="h-3 w-3 shrink-0" style="color: {trendColor(s.trend.dir)}" /></span>
								{/if}
								{s.value}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>
