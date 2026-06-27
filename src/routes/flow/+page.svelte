<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import * as Card from '$lib/components/ui/card';
	import MetricChart from '$lib/components/charts/MetricChart.svelte';
	import { scope } from '$lib/client/scope.svelte';
	import { flow } from '$lib/client/flow.svelte';
	import { fmtNum, fmtMonth } from '$lib/utils';
	import { AlertCircle, Loader2 } from '@lucide/svelte';

	const team = $derived(scope.activeTeam);
	// "the last N months" when rolling, else "N months ending <Month>".
	const windowLabel = $derived(
		scope.to ? `${scope.months} months ending ${fmtMonth(scope.to)}` : `the last ${scope.months} months`
	);

	$effect(() => {
		const repos = team?.repos ?? [];
		if (repos.length) flow.ensure(repos, scope.months, scope.to || undefined);
	});

	const data = $derived(flow.data);
	const o = $derived(data?.overall);

	// Hours -> friendly duration.
	const dur = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`);

	const loginToName = $derived(new Map((team?.members ?? []).map((m) => [m.login.toLowerCase(), m.name])));
	const name = (login: string) => loginToName.get(login.toLowerCase()) ?? login;

	const cards = $derived(
		o
			? [
					{ label: 'Time to first review', value: dur(o.firstReviewHours), hint: 'median, open to first review' },
					{ label: 'Cycle time', value: dur(o.mergeHours), hint: 'median, open to merge' },
					{ label: 'After approval', value: dur(o.postApproveHours), hint: 'median, approve to merge' },
					{ label: 'Review coverage', value: `${o.reviewedPct}%`, hint: 'merged PRs that got a review' }
				]
			: []
	);
</script>

<Topbar
	eyebrow="Flow"
	title="Where PRs get stuck"
	subtitle="Cycle time and review health for {team?.name ?? 'your team'} over {windowLabel}."
/>

<div class="px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
	{#if flow.error}
		<Card.Root class="p-10 text-center shadow-sm">
			<AlertCircle class="mx-auto h-9 w-9 text-[var(--color-negative)]" />
			<p class="mt-3 font-mono text-xs text-[var(--color-ink-600)]">{flow.error}</p>
		</Card.Root>
	{:else if !data && flow.loading}
		<div class="flex items-center justify-center gap-3 py-32 text-[var(--color-ink-600)]">
			<Loader2 class="h-5 w-5 animate-spin text-[var(--color-brand)]" />
			<span class="text-sm">Measuring review timelines…</span>
		</div>
	{:else if data && data.overall.count > 0}
		<!-- Headline stats -->
		<section class="mb-12 grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
			{#each cards as c (c.label)}
				<div>
					<div class="eyebrow mb-2">{c.label}</div>
					<div class="font-display tabular text-4xl leading-none text-[var(--color-ink-950)]">{c.value}</div>
					<div class="mt-2 text-xs text-[var(--color-ink-600)]">{c.hint}</div>
				</div>
			{/each}
		</section>

		<!-- Trends -->
		<section class="mb-12 grid grid-cols-1 gap-6 xl:grid-cols-2">
			<Card.Root class="gap-0 p-6 shadow-sm">
				<div class="mb-4 border-b border-[var(--color-ink-200)] pb-3">
					<div class="font-display text-lg leading-none">Time to first review</div>
					<div class="mt-1.5 text-xs text-[var(--color-ink-600)]">Median hours from open to first review, per month.</div>
				</div>
				<MetricChart data={data.byMonth} x="month" series={[{ key: 'firstReviewHours', label: 'Hours', color: 'var(--color-chart-3)' }]} kind="line" class="aspect-[5/2] w-full" />
			</Card.Root>
			<Card.Root class="gap-0 p-6 shadow-sm">
				<div class="mb-4 border-b border-[var(--color-ink-200)] pb-3">
					<div class="font-display text-lg leading-none">Cycle time</div>
					<div class="mt-1.5 text-xs text-[var(--color-ink-600)]">Median hours from open to merge, per month.</div>
				</div>
				<MetricChart data={data.byMonth} x="month" series={[{ key: 'mergeHours', label: 'Hours', color: 'var(--color-chart-1)' }]} kind="line" class="aspect-[5/2] w-full" />
			</Card.Root>
		</section>

		<!-- Reviewer load -->
		<section>
			<div class="mb-6">
				<div class="eyebrow mb-2">Review load</div>
				<h2 class="font-display text-[1.75rem] leading-none tracking-tight">Who's carrying the reviews</h2>
			</div>
			<Card.Root class="p-6 shadow-sm">
				{#if data.reviewerLoad.length === 0}
					<div class="py-8 text-center text-sm text-[var(--color-ink-600)]">No reviews in this window</div>
				{:else}
					{@const max = Math.max(...data.reviewerLoad.map((r) => r.prs), 1)}
					<ul class="space-y-3.5">
						{#each data.reviewerLoad as r (r.reviewer)}
							<li>
								<div class="mb-1.5 flex items-baseline justify-between text-xs">
									<a href="/people/{r.reviewer}" class="text-[var(--color-ink-900)] hover:text-[var(--color-brand)] hover:underline">{name(r.reviewer)}</a>
									<span class="font-mono tabular text-[var(--color-ink-600)]">{fmtNum(r.prs)} PRs</span>
								</div>
								<div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-ink-200)]">
									<div class="h-full rounded-full bg-[var(--color-chart-5)]" style:width={`${(r.prs / max) * 100}%`}></div>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Root>
		</section>
	{:else if data}
		<Card.Root class="p-16 text-center text-sm text-[var(--color-ink-600)] shadow-sm">No merged PRs in this window.</Card.Root>
	{/if}
</div>
