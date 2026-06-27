<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import Stat from '$lib/components/Stat.svelte';
	import MiniAreaChart from '$lib/components/charts/MiniAreaChart.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { metrics } from '$lib/client/metrics.svelte';
	import { scope } from '$lib/client/scope.svelte';
	import { fmtNum, fmtMonth } from '$lib/utils';
	import { ArrowUpRight, AlertCircle, GitBranch, Users, Activity, Loader2, FileDown } from '@lucide/svelte';

	const stats = $derived(metrics.data);
	const team = $derived(scope.activeTeam);

	const totalMonthly = $derived.by(() => {
		const byMonth = new Map<string, { created: number; merged: number; bugs: number; issues: number }>();
		for (const r of stats?.repos ?? []) {
			const m = byMonth.get(r.month) ?? { created: 0, merged: 0, bugs: 0, issues: 0 };
			m.created += r.created;
			m.merged += r.merged;
			m.bugs += r.bugs;
			m.issues += r.issues;
			byMonth.set(r.month, m);
		}
		return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	});

	const totals = $derived.by(() => {
		const empty = { created: 0, merged: 0, bugs: 0, issues: 0 };
		const last = totalMonthly.at(-1)?.[1] ?? empty;
		const prev = totalMonthly.at(-2)?.[1] ?? empty;
		const allTime = (stats?.repos ?? []).reduce(
			(acc, r) => ({
				created: acc.created + r.created,
				merged: acc.merged + r.merged,
				bugs: acc.bugs + r.bugs,
				issues: acc.issues + r.issues
			}),
			{ ...empty }
		);
		const trend = (cur: number, p: number) => (p === 0 ? 0 : ((cur - p) / p) * 100);
		return {
			last,
			allTime,
			trends: {
				created: trend(last.created, prev.created),
				merged: trend(last.merged, prev.merged),
				bugs: trend(last.bugs, prev.bugs)
			}
		};
	});

	const mergedSpark = $derived(totalMonthly.map(([, v]) => v.merged));
	const createdSpark = $derived(totalMonthly.map(([, v]) => v.created));
	const bugSpark = $derived(totalMonthly.map(([, v]) => v.bugs));

	const topRepos = $derived.by(() => {
		const byRepo = new Map<string, { merged: number; created: number; bugs: number }>();
		for (const r of stats?.repos ?? []) {
			const k = `${r.owner}/${r.repo}`;
			const e = byRepo.get(k) ?? { merged: 0, created: 0, bugs: 0 };
			e.merged += r.merged;
			e.created += r.created;
			e.bugs += r.bugs;
			byRepo.set(k, e);
		}
		return [...byRepo.entries()].sort((a, b) => b[1].merged - a[1].merged).slice(0, 6);
	});

	// Map GitHub login -> the team member's display name (case-insensitive).
	const loginToName = $derived(new Map((team?.members ?? []).map((m) => [m.login.toLowerCase(), m.name])));
	const displayName = (login: string) => loginToName.get(login.toLowerCase()) ?? login;

	// Every team member, with their commit count (0 if none), ranked — not capped.
	const topAuthors = $derived.by(() => {
		const byAuthor = new Map<string, number>();
		for (const a of stats?.authors ?? []) {
			const k = a.author.toLowerCase();
			byAuthor.set(k, (byAuthor.get(k) ?? 0) + a.commits);
		}
		return (team?.members ?? [])
			.map((m) => [m.login, byAuthor.get(m.login.toLowerCase()) ?? 0] as [string, number])
			.sort((a, b) => b[1] - a[1]);
	});

	// Every team member's lines added/removed (merged PRs), ranked — not capped.
	const topLines = $derived.by(() => {
		const byLogin = new Map(
			(stats?.linesByAuthor ?? []).map((l) => [l.author.toLowerCase(), l])
		);
		return (team?.members ?? [])
			.map((m) => {
				const l = byLogin.get(m.login.toLowerCase());
				const additions = l?.additions ?? 0;
				const deletions = l?.deletions ?? 0;
				return { author: m.login, additions, deletions, total: additions + deletions };
			})
			.sort((a, b) => b.total - a.total);
	});

	const lastRun = $derived(
		stats?.generatedAt
			? new Date(stats.generatedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
			: '—'
	);
</script>

<Topbar
	eyebrow="Overview"
	title="The state of the team."
	subtitle="Delivery velocity, review depth, and incoming quality signals for {team?.name ?? 'your team'}."
>
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
			<h2 class="font-display text-2xl mt-4">Couldn't load metrics</h2>
			<p class="mt-2 font-mono text-xs text-[var(--color-ink-600)]">{metrics.error}</p>
		</Card.Root>
	{:else if !stats && metrics.loading}
		<div class="flex items-center justify-center gap-3 py-32 text-[var(--color-ink-600)]">
			<Loader2 class="h-5 w-5 animate-spin text-[var(--color-brand)]" />
			<span class="text-sm">Fetching live metrics from GitHub…</span>
		</div>
	{:else if stats}
		<!-- metadata strip -->
		<div class="mb-10 flex items-center gap-x-6 gap-y-3 border-b border-[var(--color-ink-300)] pb-6 text-xs flex-wrap sm:mb-12 sm:gap-x-10">
			<div class="flex items-center gap-2 text-[var(--color-ink-700)]">
				<GitBranch class="h-3.5 w-3.5" />
				<span class="font-mono tabular text-[var(--color-ink-900)]">{team?.repos.length ?? 0}</span> repositories
			</div>
			<div class="flex items-center gap-2 text-[var(--color-ink-700)]">
				<Users class="h-3.5 w-3.5" />
				<span class="font-mono tabular text-[var(--color-ink-900)]">{team?.members.length ?? 0}</span> members
			</div>
			<div class="flex items-center gap-2 text-[var(--color-ink-700)]">
				<Activity class="h-3.5 w-3.5" />
				window: <span class="font-mono tabular text-[var(--color-ink-900)]">{scope.months}m</span>
			</div>
			<div class="ml-auto flex items-center gap-2 text-[var(--color-ink-700)]">
				{#if metrics.loading}<Loader2 class="h-3.5 w-3.5 animate-spin text-[var(--color-brand)]" />{/if}
				fetched: <span class="font-mono tabular text-[var(--color-ink-900)]">{lastRun}</span>
			</div>
		</div>

		<!-- Hero stats -->
		<section class="mb-14 grid grid-cols-12 gap-x-6 gap-y-8 sm:gap-x-8 sm:gap-y-10">
			<div class="col-span-12 md:col-span-5">
				<Stat label="PRs merged · last month" value={totals.last.merged} trend={totals.trends.merged} hint="vs. previous month" size="lg" />
				<div class="mt-6"><MiniAreaChart values={mergedSpark} width={300} height={48} /></div>
			</div>
			<div class="col-span-6 md:col-span-3 md:border-l md:border-[var(--color-ink-300)] md:pl-8">
				<Stat label="PRs opened" value={totals.last.created} trend={totals.trends.created} size="md" />
				<div class="mt-5"><MiniAreaChart values={createdSpark} width={180} height={36} stroke="var(--color-info)" /></div>
			</div>
			<div class="col-span-6 md:col-span-2 md:border-l md:border-[var(--color-ink-300)] md:pl-8">
				<Stat label="Bugs raised" value={totals.last.bugs} trend={totals.trends.bugs} size="md" />
				<div class="mt-5"><MiniAreaChart values={bugSpark} width={140} height={36} stroke="var(--color-negative)" /></div>
			</div>
			<div class="col-span-12 md:col-span-2 md:border-l md:border-[var(--color-ink-300)] md:pl-8">
				<Stat label={`Window · ${scope.months}m`} value={fmtNum(totals.allTime.merged)} unit="merged" size="md" />
				<div class="mt-3 text-xs text-[var(--color-ink-700)]">
					<span class="font-mono tabular text-[var(--color-ink-900)]">{fmtNum(totals.allTime.created)}</span> created total
				</div>
			</div>
		</section>

		<!-- Most active repositories -->
		<section class="mb-14">
			<div class="mb-6 flex items-baseline justify-between">
				<div>
					<div class="eyebrow mb-2">Most active repositories</div>
					<h2 class="font-display text-[1.75rem] leading-none tracking-tight">Where the shipping happens</h2>
				</div>
				<a href="/charts" class="text-xs text-[var(--color-ink-700)] hover:text-[var(--color-brand)] inline-flex items-center gap-1">
					View all <ArrowUpRight class="h-3 w-3" />
				</a>
			</div>
			<Card.Root class="gap-0 py-0 overflow-hidden shadow-sm">
				{#each topRepos as [repo, m], i (repo)}
					<div class="group flex items-center gap-5 px-5 py-4 {i !== 0 ? 'border-t border-[var(--color-ink-200)]' : ''}">
						<span class="font-mono tabular text-xs text-[var(--color-ink-500)] w-6">{String(i + 1).padStart(2, '0')}</span>
						<div class="flex-1 min-w-0">
							<div class="font-display text-base text-[var(--color-ink-950)] truncate">{repo}</div>
							<div class="mt-0.5 font-mono text-[11px] text-[var(--color-ink-600)]">{m.created} created · {m.bugs} {m.bugs === 1 ? 'bug' : 'bugs'}</div>
						</div>
						<div class="text-right">
							<div class="font-display tabular text-2xl leading-none text-[var(--color-ink-950)]">{m.merged}</div>
							<div class="eyebrow mt-1.5">merged</div>
						</div>
					</div>
				{:else}
					<div class="px-5 py-10 text-center text-sm text-[var(--color-ink-600)]">No data</div>
				{/each}
			</Card.Root>
		</section>

		<!-- Contributor leaderboards, side by side -->
		<section class="grid grid-cols-1 gap-8 lg:grid-cols-2">
			<div>
				<div class="mb-6">
					<div class="eyebrow mb-2">Commit leaderboard</div>
					<h2 class="font-display text-[1.75rem] leading-none tracking-tight">Who's pushing the code</h2>
				</div>
				<Card.Root class="p-6 shadow-sm">
					{#if topAuthors.length === 0}
						<div class="py-8 text-center text-sm text-[var(--color-ink-600)]">No commit data</div>
					{:else}
						{@const max = Math.max(...topAuthors.map(([, n]) => n), 1)}
						<ul class="space-y-3.5">
							{#each topAuthors as [name, count] (name)}
								<li>
									<div class="flex items-baseline justify-between text-xs mb-1.5">
										<a href="/people/{name}" class="text-[var(--color-ink-900)] hover:text-[var(--color-brand)] hover:underline">{displayName(name)}</a>
										<span class="font-mono tabular text-[var(--color-ink-600)]">{fmtNum(count)}</span>
									</div>
									<div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-ink-200)]">
										<div class="h-full rounded-full bg-[var(--color-brand)]" style:width={`${(count / max) * 100}%`}></div>
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Root>
			</div>

			<div>
				<div class="mb-6">
					<div class="eyebrow mb-2">Lines of code · merged PRs</div>
					<h2 class="font-display text-[1.75rem] leading-none tracking-tight">Who's changing the most</h2>
				</div>
				<Card.Root class="p-6 shadow-sm">
					{#if topLines.length === 0}
						<div class="py-8 text-center text-sm text-[var(--color-ink-600)]">No line data</div>
					{:else}
						{@const max = Math.max(...topLines.map((l) => l.total), 1)}
						<ul class="space-y-3.5">
							{#each topLines as l (l.author)}
								<li>
									<div class="flex items-baseline justify-between gap-3 text-xs mb-1.5">
										<a href="/people/{l.author}" class="truncate text-[var(--color-ink-900)] hover:text-[var(--color-brand)] hover:underline">{displayName(l.author)}</a>
										<span class="font-mono tabular shrink-0">
											<span class="text-[var(--color-positive)]">+{fmtNum(l.additions)}</span>
											<span class="text-[var(--color-negative)]">−{fmtNum(l.deletions)}</span>
										</span>
									</div>
									<div class="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-ink-200)]">
										<div class="h-full bg-[var(--color-positive)]" style:width={`${(l.additions / max) * 100}%`} title={`${fmtNum(l.additions)} added`}></div>
										<div class="h-full bg-[var(--color-negative)]" style:width={`${(l.deletions / max) * 100}%`} title={`${fmtNum(l.deletions)} removed`}></div>
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Root>
			</div>
		</section>

		<!-- Cadence -->
		{#if totalMonthly.length > 0}
			{@const maxBar = Math.max(...totalMonthly.map(([, v]) => v.merged), 1)}
			<section class="mt-16">
				<div class="mb-6">
					<div class="eyebrow mb-2">Pull requests merged · per month</div>
					<h2 class="font-display text-[1.75rem] leading-none tracking-tight">Merged PRs, month by month</h2>
					<p class="mt-2 max-w-xl text-sm text-[var(--color-ink-600)]">
						Each bar is the number of pull requests the team merged that month — taller means more shipped.
					</p>
				</div>
				<Card.Root class="p-8 shadow-sm">
					<div class="flex items-end justify-between gap-2 h-52 border-b border-[var(--color-ink-200)]">
						{#each totalMonthly as [month, v] (month)}
							<div class="flex-1 flex flex-col items-center gap-1.5 group cursor-default">
								<div class="font-mono tabular text-[11px] text-[var(--color-ink-700)] group-hover:text-[var(--color-ink-950)]">{v.merged}</div>
								<div class="w-full bg-[var(--color-brand)]/80 rounded-t-sm transition-all group-hover:bg-[var(--color-brand)]" style:height={`${Math.max((v.merged / maxBar) * 150, 2)}px`}></div>
							</div>
						{/each}
					</div>
					<div class="flex justify-between gap-2 pt-2">
						{#each totalMonthly as [month] (month)}
							<div class="flex-1 text-center text-[10px] font-mono uppercase tracking-wider text-[var(--color-ink-600)]">{fmtMonth(month)}</div>
						{/each}
					</div>
				</Card.Root>
			</section>
		{/if}
	{/if}
</div>
