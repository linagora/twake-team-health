<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import MetricChart from '$lib/components/charts/MetricChart.svelte';
	import * as Card from '$lib/components/ui/card';
	import { metrics } from '$lib/client/metrics.svelte';
	import { scope } from '$lib/client/scope.svelte';
	import {
		repoSeries,
		commitsChart,
		mergedPrChart,
		reviewActivityChart,
		ticketsChart,
		commitsByRepoChart
	} from '$lib/charts';
	import type { AppConfig } from '$lib/server/config';
	import { Button } from '$lib/components/ui/button';
	import { fmtMonth } from '$lib/utils';
	import { AlertCircle, Loader2, FileDown } from '@lucide/svelte';

	const stats = $derived(metrics.data);
	const team = $derived(scope.activeTeam);

	// Resolve a login to its display name (commits-by-repo series are keyed by login).
	const memberName = $derived(new Map((team?.members ?? []).map((m) => [m.login, m.name])));
	const nameOf = (login: string) => memberName.get(login) ?? login;

	// AppConfig view of the active team for the chart transforms.
	const config = $derived<AppConfig>({
		months: scope.months,
		commit_months: scope.memberMonths,
		repo_list: team?.repos.map((r) => [r.owner, r.repo]) ?? [],
		active_teams: team ? [team.name] : [],
		teams: team
			? [
					{
						name: team.name,
						authors: team.members.map((m) => [m.login, m.name, m.email ?? '']),
						repos: team.repos.map((r) => [r.owner, r.repo])
					}
				]
			: []
	});

	type SeriesCfg = { key: string; label: string; color: string };
	const CHART_COLORS = ['var(--color-chart-1)', 'var(--color-chart-2)', 'var(--color-chart-3)', 'var(--color-chart-5)', 'var(--color-chart-4)'];

	const CATEGORIES: { key: string; label: string; blurb: string }[] = [
		{ key: 'nb_pr', label: 'PRs created vs. merged', blurb: 'Pull requests opened against those that landed, month by month.' },
		{ key: 'nb_days_pr', label: 'Days per PR', blurb: 'Average lifetime of a pull request before it merged.' },
		{ key: 'nb_lines_pr', label: 'Lines per PR', blurb: 'Code churn per pull request, additions against deletions.' },
		{ key: 'nb_interactions_pr', label: 'Interactions per PR', blurb: 'Conversation depth: comments and reviews per pull request.' },
		{ key: 'nb_bugs_issues', label: 'Bugs & issues', blurb: 'Incoming issues each month, and how many were bugs.' },
		{ key: 'stock', label: 'Stock', blurb: 'Open backlog at each month end: issues, bugs, and pull requests.' },
		{ key: 'bug_resolution', label: 'Bug resolution', blurb: 'How quickly bugs were resolved, and the share that got closed.' },
		{ key: 'releases', label: 'Releases', blurb: 'Published releases shipped each month.' },
		{ key: 'Commits', label: 'Commits', blurb: 'Commits landed by each team member over recent months.' },
		{ key: 'CommitsByRepo', label: 'Commits by repo', blurb: 'Where each member committed, broken down by repository.' },
		{ key: 'MergedPRs', label: 'Merged PRs', blurb: 'Pull requests merged by each team member over recent months.' },
		{ key: 'Reviews', label: 'Reviews', blurb: 'Reviews and comments each member left on pull requests.' },
		{ key: 'Tickets', label: 'Tickets', blurb: 'Tickets opened across the team each month, bugs highlighted.' }
	];

	const PER_REPO: Record<string, { kind: 'line' | 'area' | 'bar'; seriesLayout?: 'overlap' | 'stack' | 'group'; series: SeriesCfg[] }> = {
		nb_pr: { kind: 'line', series: [{ key: 'created', label: 'Created', color: 'var(--color-chart-2)' }, { key: 'merged', label: 'Merged', color: 'var(--color-chart-1)' }] },
		nb_days_pr: { kind: 'line', series: [{ key: 'daysPerPr', label: 'Avg days / PR', color: 'var(--color-chart-1)' }] },
		nb_lines_pr: { kind: 'area', seriesLayout: 'overlap', series: [{ key: 'addPerPr', label: 'Additions / PR', color: 'var(--color-chart-3)' }, { key: 'delPerPr', label: 'Deletions / PR', color: 'var(--color-chart-4)' }] },
		nb_interactions_pr: { kind: 'line', series: [{ key: 'commentsPerPr', label: 'Comments / PR', color: 'var(--color-chart-2)' }, { key: 'reviewsPerPr', label: 'Reviews / PR', color: 'var(--color-chart-5)' }] },
		nb_bugs_issues: { kind: 'bar', seriesLayout: 'group', series: [{ key: 'issues', label: 'Issues', color: 'var(--color-chart-2)' }, { key: 'bugs', label: 'Bugs', color: 'var(--color-chart-4)' }] },
		stock: { kind: 'line', series: [{ key: 'issuesOpen', label: 'Issues open', color: 'var(--color-chart-1)' }, { key: 'bugsOpen', label: 'Bugs open', color: 'var(--color-chart-4)' }, { key: 'prsOpen', label: 'PRs open', color: 'var(--color-chart-3)' }] },
		bug_resolution: { kind: 'line', series: [{ key: 'resolutionDays', label: 'Median days', color: 'var(--color-chart-1)' }, { key: 'resolutionRate', label: 'Resolution rate %', color: 'var(--color-chart-2)' }] },
		releases: { kind: 'bar', series: [{ key: 'releases', label: 'Releases', color: 'var(--color-chart-5)' }] }
	};

	let activeCategory = $state('nb_pr');
	// Switch category and scroll back to the top. Charts render lazily when they
	// enter the viewport, so keeping a scrolled position would leave the new
	// category's top charts mounted above the fold and blank.
	function selectCategory(key: string) {
		activeCategory = key;
		if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
	}

	// Only one category renders at a time, so compute each transform lazily — eagerly
	// running all six (the member-heavy ones especially) is what froze navigation in.
	const EMPTY_MEMBER = { months: [] as string[], data: [], members: [] as string[] };
	const repos = $derived(stats && PER_REPO[activeCategory] ? repoSeries(stats.repos) : []);
	const commits = $derived(stats && activeCategory === 'Commits' ? commitsChart(stats, config) : EMPTY_MEMBER);
	const merged = $derived(stats && activeCategory === 'MergedPRs' ? mergedPrChart(stats, config) : EMPTY_MEMBER);
	const reviews = $derived(stats && activeCategory === 'Reviews' ? reviewActivityChart(stats, config) : []);
	const tickets = $derived(stats && activeCategory === 'Tickets' ? ticketsChart(stats) : []);
	const commitsByRepo = $derived(stats && activeCategory === 'CommitsByRepo' ? commitsByRepoChart(stats, config) : { repos: [], data: [], members: [] });

	// Map a set of keys to colored series; `label` formats the displayed name.
	function keySeries(keys: string[], label: (k: string) => string = (k) => k): SeriesCfg[] {
		return keys.map((k, i) => ({ key: k, label: label(k), color: CHART_COLORS[i % CHART_COLORS.length] }));
	}

	const hasMember = (c: { data: unknown[]; months?: string[] }) => c.data.length > 0;
	const reviewMembers = $derived(reviews.filter((r) => r.name !== 'Others'));
	const reviewOthers = $derived(reviews.find((r) => r.name === 'Others'));

	const cat = $derived(CATEGORIES.find((c) => c.key === activeCategory));
	const perRepoCfg = $derived(PER_REPO[activeCategory]);
</script>

<Topbar eyebrow="Charts" title="The charts." subtitle="Every metric drawn live from GitHub for {team?.name ?? 'your team'}.">
	{#snippet actions()}
		{#if stats}
			<Button variant="outline" size="lg" onclick={() => window.print()}>
				<FileDown class="h-4 w-4" /> Export PDF
			</Button>
		{/if}
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
			<span class="text-sm">Fetching live metrics…</span>
		</div>
	{:else if stats}
		<div class="grid grid-cols-12 gap-8">
			<aside class="col-span-12 lg:col-span-3">
				<div class="eyebrow mb-4 hidden lg:block">Categories</div>
				<!-- Horizontal chip scroller on mobile; sticky vertical list on lg+. -->
				<nav class="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0 lg:pb-0 lg:sticky lg:top-32">
					{#each CATEGORIES as c (c.key)}
						<button
							onclick={() => selectCategory(c.key)}
							class="group flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left transition-colors lg:w-full lg:gap-3 lg:py-2.5 {activeCategory === c.key ? 'bg-[var(--color-brand)]/10 text-[var(--color-ink-950)]' : 'border border-[var(--color-ink-200)] text-[var(--color-ink-700)] hover:bg-[var(--color-ink-100)] hover:text-[var(--color-ink-900)] lg:border-0'}"
						>
							<span class="h-1.5 w-1.5 shrink-0 rounded-full {activeCategory === c.key ? 'bg-[var(--color-brand)]' : 'bg-[var(--color-ink-400)]'}"></span>
							<span class="text-sm">{c.label}</span>
						</button>
					{/each}
				</nav>
			</aside>

			<section class="col-span-12 lg:col-span-9">
				{#if cat}
					<div class="mb-8 max-w-xl">
						<div class="eyebrow mb-2">Showing</div>
						<h2 class="font-display text-[2.4rem] leading-[0.95] tracking-tight">{cat.label}</h2>
						<p class="mt-3 text-sm leading-relaxed text-[var(--color-ink-600)]">{cat.blurb}</p>
					</div>

					{#if perRepoCfg}
						{#if repos.length === 0}
							<Card.Root class="p-10 text-center text-sm text-[var(--color-ink-600)]">No repo data.</Card.Root>
						{:else}
							<div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
								{#each repos as repo, i (repo.key)}
									<Card.Root class="gap-0 p-6 shadow-sm">
										<div class="mb-5 flex items-baseline justify-between gap-3 border-b border-[var(--color-ink-200)] pb-3">
											<span class="flex items-baseline gap-3">
												<span class="font-mono text-[10px] tabular text-[var(--color-ink-500)]">{(i + 1).toString().padStart(2, '0')}</span>
												<span class="font-display text-lg leading-none">{repo.label}</span>
											</span>
											<span class="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-500)]">{repo.owner}</span>
										</div>
										<MetricChart data={repo.points} series={perRepoCfg.series} kind={perRepoCfg.kind} seriesLayout={perRepoCfg.seriesLayout} />
									</Card.Root>
								{/each}
							</div>
						{/if}
					{:else if activeCategory === 'Commits' || activeCategory === 'MergedPRs'}
						{@const chart = activeCategory === 'Commits' ? commits : merged}
						<Card.Root class="p-7 shadow-sm">
							{#if hasMember(chart)}
								<MetricChart data={chart.data} x="member" series={keySeries(chart.months, fmtMonth)} kind="bar" seriesLayout="group" class="aspect-[2/1] w-full" />
							{:else}
								<div class="py-10 text-center text-sm text-[var(--color-ink-600)]">No member data.</div>
							{/if}
						</Card.Root>
					{:else if activeCategory === 'CommitsByRepo'}
						<Card.Root class="p-7 shadow-sm">
							{#if commitsByRepo.data.length}
								<MetricChart data={commitsByRepo.data} x="repo" series={keySeries(commitsByRepo.members, nameOf)} kind="bar" seriesLayout="stack" class="aspect-[2/1] w-full" />
							{:else}
								<div class="py-10 text-center text-sm text-[var(--color-ink-600)]">No commit data.</div>
							{/if}
						</Card.Root>
					{:else if activeCategory === 'Reviews'}
						<Card.Root class="p-7 shadow-sm">
							{#if reviewMembers.length}
								<MetricChart data={reviewMembers} x="name" series={[{ key: 'reviews', label: 'Reviews', color: 'var(--color-chart-1)' }, { key: 'comments', label: 'PR comments', color: 'var(--color-chart-2)' }]} kind="bar" seriesLayout="stack" class="aspect-[2/1] w-full" />
								{#if reviewOthers && (reviewOthers.reviews || reviewOthers.comments)}
									<p class="mt-5 border-t border-[var(--color-ink-200)] pt-4 text-xs text-[var(--color-ink-600)]">
										Plus <span class="font-mono tabular text-[var(--color-ink-800)]">{reviewOthers.reviews.toLocaleString()}</span> reviews and
										<span class="font-mono tabular text-[var(--color-ink-800)]">{reviewOthers.comments.toLocaleString()}</span> comments from authors outside the team.
									</p>
								{/if}
							{:else}
								<div class="py-10 text-center text-sm text-[var(--color-ink-600)]">No review data.</div>
							{/if}
						</Card.Root>
					{:else if activeCategory === 'Tickets'}
						<Card.Root class="p-7 shadow-sm">
							{#if tickets.length}
								<MetricChart data={tickets} x="month" series={[{ key: 'tickets', label: 'Tickets', color: 'var(--color-chart-2)' }, { key: 'bugs', label: 'Bugs', color: 'var(--color-chart-4)' }]} kind="bar" seriesLayout="group" class="aspect-[2/1] w-full" />
							{:else}
								<div class="py-10 text-center text-sm text-[var(--color-ink-600)]">No ticket data.</div>
							{/if}
						</Card.Root>
					{/if}
				{/if}
			</section>
		</div>
	{/if}
</div>
