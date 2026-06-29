<script lang="ts">
	import { page } from '$app/state';
	import Topbar from '$lib/components/Topbar.svelte';
	import * as Card from '$lib/components/ui/card';
	import { metrics } from '$lib/client/metrics.svelte';
	import { scope } from '$lib/client/scope.svelte';
	import { fmtNum } from '$lib/utils';
	import { Loader2, ArrowLeft, AlertCircle } from '@lucide/svelte';
	import Avatar from '$lib/components/Avatar.svelte';

	const login = $derived(page.params.login ?? '');
	const lc = (s: string) => s.toLowerCase();
	const stats = $derived(metrics.data);
	const team = $derived(scope.activeTeam);
	const member = $derived((team?.members ?? []).find((m) => lc(m.login) === lc(login)));
	const name = $derived(member?.name ?? login);
	const commitsByMonth = $derived(
		(stats?.authors ?? []).filter((a) => lc(a.author) === lc(login)).sort((a, b) => a.month.localeCompare(b.month))
	);
	const totalCommits = $derived(commitsByMonth.reduce((s, a) => s + a.commits, 0));
	const lines = $derived((stats?.linesByAuthor ?? []).find((l) => lc(l.author) === lc(login)) ?? { additions: 0, deletions: 0 });
	const merged = $derived(
		(stats?.mergedByAuthor ?? []).filter((m) => lc(m.author) === lc(login)).reduce((s, m) => s + m.mergedPRs, 0)
	);
	const review = $derived((stats?.reviewActivity ?? []).find((r) => lc(r.author) === lc(login)) ?? { reviews: 0, comments: 0 });
	const byRepo = $derived(
		(stats?.commitsByAuthorRepo ?? []).filter((c) => lc(c.author) === lc(login)).sort((a, b) => b.commits - a.commits)
	);
	// Work pattern (weekend / late-night commit share, author-local time) for burnout.
	const pattern = $derived((stats?.workPattern ?? []).find((w) => lc(w.author) === lc(login)));
	const pct = (n: number) => (pattern && pattern.commits ? Math.round((n / pattern.commits) * 100) : 0);
	const weekendPct = $derived(pct(pattern?.weekendCommits ?? 0));
	const lateNightPct = $derived(pct(pattern?.lateNightCommits ?? 0));

	const hasActivity = $derived(totalCommits > 0 || merged > 0 || review.reviews > 0 || lines.additions + lines.deletions > 0);
</script>

<svelte:head><title>{name} · team·health</title></svelte:head>

<Topbar eyebrow="Profile" title={name} subtitle="{login} · {team?.name ?? 'team'} · last {scope.memberMonths} months">
	{#snippet actions()}
		<a href="/" class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] px-3 py-1.5 text-xs text-[var(--color-ink-800)] hover:border-[var(--color-ink-400)]">
			<ArrowLeft class="h-3.5 w-3.5" /> Overview
		</a>
	{/snippet}
</Topbar>

<div class="px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
	{#if metrics.error}
		<Card.Root class="p-10 text-center shadow-sm">
			<AlertCircle class="mx-auto h-9 w-9 text-[var(--color-negative)]" />
			<p class="mt-3 font-mono text-xs text-[var(--color-ink-600)]">{metrics.error}</p>
		</Card.Root>
	{:else if !stats && metrics.loading}
		<div class="flex items-center justify-center gap-3 py-32 text-[var(--color-ink-600)]">
			<Loader2 class="h-5 w-5 animate-spin text-[var(--color-brand)]" />
			<span class="text-sm">Loading…</span>
		</div>
	{:else if stats}
		<div class="mb-10 flex items-center gap-4">
			<Avatar {login} {name} size={56} />
			<div>
				<div class="font-display text-2xl leading-none text-[var(--color-ink-950)]">{name}</div>
				<a href="https://github.com/{login}" target="_blank" rel="noopener noreferrer" class="font-mono text-xs text-[var(--color-ink-600)] hover:text-[var(--color-brand)]">@{login}</a>
			</div>
		</div>

		{#if !hasActivity}
			<Card.Root class="p-16 text-center text-sm text-[var(--color-ink-600)] shadow-sm">
				No activity for {name} in {team?.name} over the last {scope.memberMonths} months.
			</Card.Root>
		{:else}
			<!-- Stat cards -->
			<section class="mb-12 grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
				<div>
					<div class="eyebrow mb-2">Commits</div>
					<div class="font-display tabular text-4xl leading-none text-[var(--color-ink-950)]">{fmtNum(totalCommits)}</div>
				</div>
				<div>
					<div class="eyebrow mb-2">Lines changed</div>
					<div class="font-display tabular text-4xl leading-none text-[var(--color-ink-950)]">{fmtNum(lines.additions + lines.deletions)}</div>
					<div class="mt-2 font-mono text-xs">
						<span class="text-[var(--color-positive)]">+{fmtNum(lines.additions)}</span>
						<span class="text-[var(--color-negative)]">−{fmtNum(lines.deletions)}</span>
					</div>
				</div>
				<div>
					<div class="eyebrow mb-2">Merged PRs</div>
					<div class="font-display tabular text-4xl leading-none text-[var(--color-ink-950)]">{fmtNum(merged)}</div>
				</div>
				<div>
					<div class="eyebrow mb-2">Reviews given</div>
					<div class="font-display tabular text-4xl leading-none text-[var(--color-ink-950)]">{fmtNum(review.reviews)}</div>
					<div class="mt-2 font-mono text-xs text-[var(--color-ink-600)]">{fmtNum(review.comments)} comments</div>
				</div>
				<div>
					<div class="eyebrow mb-2">Weekend commits</div>
					<div class="font-display tabular text-4xl leading-none text-[var(--color-ink-950)]">{weekendPct}%</div>
					<div class="mt-2 font-mono text-xs text-[var(--color-ink-600)]">{fmtNum(pattern?.weekendCommits ?? 0)} on Sat/Sun (local)</div>
				</div>
				<div>
					<div class="eyebrow mb-2">Late-night commits</div>
					<div class="font-display tabular text-4xl leading-none text-[var(--color-ink-950)]">{lateNightPct}%</div>
					<div class="mt-2 font-mono text-xs text-[var(--color-ink-600)]">{fmtNum(pattern?.lateNightCommits ?? 0)} after 10pm (local)</div>
				</div>
			</section>

			<!-- Commits by repo -->
			<section>
				<div class="mb-6">
					<div class="eyebrow mb-2">Where they work</div>
					<h3 class="font-display text-[1.75rem] leading-none tracking-tight">Commits by repository</h3>
				</div>
				<Card.Root class="p-6 shadow-sm">
					{#if byRepo.length === 0}
						<div class="py-8 text-center text-sm text-[var(--color-ink-600)]">No commits in this window</div>
					{:else}
						{@const max = Math.max(...byRepo.map((r) => r.commits), 1)}
						<ul class="space-y-3.5">
							{#each byRepo as r (r.repo)}
								<li>
									<div class="mb-1.5 flex items-baseline justify-between text-xs">
										<span class="font-mono text-[var(--color-ink-800)]">{r.repo}</span>
										<span class="font-mono tabular text-[var(--color-ink-600)]">{fmtNum(r.commits)}</span>
									</div>
									<div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-ink-200)]">
										<div class="h-full rounded-full bg-[var(--color-brand)]" style:width={`${(r.commits / max) * 100}%`}></div>
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Root>
			</section>
		{/if}
	{:else}
		<Card.Root class="p-16 text-center text-sm text-[var(--color-ink-600)] shadow-sm">Pick a team to see member profiles.</Card.Root>
	{/if}
</div>
