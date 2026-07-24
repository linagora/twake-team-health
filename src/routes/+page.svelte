<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import Stat from '$lib/components/Stat.svelte';
	import MiniAreaChart from '$lib/components/charts/MiniAreaChart.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { metrics } from '$lib/client/metrics.svelte';
	import { scope } from '$lib/client/scope.svelte';
	import { exportPdf } from '$lib/client/print.svelte';
	import { fmtNum, fmtMonth } from '$lib/utils';
	import { monthKeyOf } from '$lib/months';
	import { ArrowUpRight, AlertCircle, GitBranch, Users, Activity, Loader2, FileDown, Zap, GitMerge, ShieldCheck, MessageSquare, Scale, Compass, Trophy } from '@lucide/svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import { computeAwards, computeAwardsFromRecent } from '$lib/awards';

	let { data } = $props();

	// Fall back to the server-rendered default metrics until the client store loads,
	// so the first paint shows data instead of a spinner. Resolve member names from
	// the default team during SSR too (the scope store is client-only).
	const stats = $derived(metrics.data ?? data.initial);
	const team = $derived(scope.activeTeam ?? data.defaultTeams?.[0]);

	// Playful per-member superlatives ("The Machine", etc.) for the standouts row.
	// Rolling trailing-30d by default; monthly only as a stale-cache fallback.
	const awards = $derived.by(() => {
		if (!stats) return [];
		const members = team?.members ?? [];
		const recent = stats.recentMembers ?? [];
		return recent.length ? computeAwardsFromRecent(recent, members) : computeAwards(stats, members);
	});
	const awardIcon: Record<string, typeof Zap> = {
		commits: Zap,
		merged: GitMerge,
		reviews: ShieldCheck,
		comments: MessageSquare,
		lines: Scale,
		breadth: Compass
	};

	// The report's buckets run through today; the in-progress month is real data.
	// `allMonthly` keeps it for the bar chart, which renders it as a distinct
	// month-to-date bar. `totalMonthly` drops it everywhere a partial month would
	// be read as a whole one: the hero fallback and its month-over-month trends,
	// and the sparklines that sit under those numbers.
	const allMonthly = $derived.by(() => {
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
	// Re-read with each refresh rather than captured once at init: this page is
	// meant to sit open on a wall display, and a stale key would leave the "MTD"
	// marker on a month that has since completed while the genuinely partial one
	// renders as finished.
	const currentMonthKey = $derived.by(() => {
		void allMonthly;
		return monthKeyOf();
	});
	const totalMonthly = $derived(allMonthly.filter(([month]) => month < currentMonthKey));

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

	// Hero headline: the rolling last-30-days window, aggregated server-side from
	// facts. It always spans a full 30 days, so it never cliffs to ~0 on the 1st
	// the way an in-progress calendar month does. Falls back to the last complete
	// month's totals only when a (stale-cached) result predates the window field.
	const win = $derived(stats?.window30d ?? null);
	const hasWindow = $derived(!!win && win.computedAt !== null);

	const hero = $derived.by(() => {
		const trend = (cur: number, p: number) => (p === 0 ? 0 : ((cur - p) / p) * 100);
		if (win && hasWindow) {
			const c = win.current;
			const p = win.previous;
			return {
				merged: c.merged,
				created: c.created,
				bugs: c.bugs,
				trends: { merged: trend(c.merged, p.merged), created: trend(c.created, p.created), bugs: trend(c.bugs, p.bugs) }
			};
		}
		return { merged: totals.last.merged, created: totals.last.created, bugs: totals.last.bugs, trends: totals.trends };
	});
	const heroPeriod = $derived(hasWindow ? 'last 30 days' : 'last month');
	const heroHint = $derived(hasWindow ? 'vs. previous 30 days' : 'vs. previous month');

	// Sparklines: rolling daily series over the trailing window (falls back to the
	// monthly buckets only for a stale-cached result without the daily field).
	// `recentDaily` and `window30d` are missing together, so the fallback fires in
	// exactly the case where the number above the line is `totals.last`, labelled
	// "last month", so the line has to end on that same complete month or the tile
	// contradicts its own sparkline. Marking a partial tail would not reconcile the
	// two: the headline figure itself is last month's.
	const daily = $derived(stats?.recentDaily ?? []);
	const mergedSpark = $derived(daily.length ? daily.map((d) => d.merged) : totalMonthly.map(([, v]) => v.merged));
	const createdSpark = $derived(daily.length ? daily.map((d) => d.created) : totalMonthly.map(([, v]) => v.created));
	const bugSpark = $derived(daily.length ? daily.map((d) => d.bugs) : totalMonthly.map(([, v]) => v.bugs));

	// Most active repositories over the trailing 30 days, with a vs-previous-30d
	// delta on merges. Falls back to monthly window sums for a stale-cached result.
	const topRepos = $derived.by(() => {
		const recent = stats?.recentRepos ?? [];
		if (recent.length) {
			return recent
				.map((r) => ({
					repo: `${r.owner}/${r.repo}`,
					merged: r.current.merged,
					created: r.current.created,
					bugs: r.current.bugs,
					delta: r.current.merged - r.previous.merged
				}))
				.filter((r) => r.merged > 0 || r.created > 0 || r.bugs > 0)
				.sort((a, b) => b.merged - a.merged)
				.slice(0, 6);
		}
		const byRepo = new Map<string, { repo: string; merged: number; created: number; bugs: number; delta: number }>();
		for (const r of stats?.repos ?? []) {
			const k = `${r.owner}/${r.repo}`;
			const e = byRepo.get(k) ?? { repo: k, merged: 0, created: 0, bugs: 0, delta: 0 };
			e.merged += r.merged;
			e.created += r.created;
			e.bugs += r.bugs;
			byRepo.set(k, e);
		}
		return [...byRepo.values()].sort((a, b) => b.merged - a.merged).slice(0, 6);
	});

	// Map GitHub login -> the team member's display name (case-insensitive).
	const loginToName = $derived(new Map((team?.members ?? []).map((m) => [m.login.toLowerCase(), m.name])));
	const displayName = (login: string) => loginToName.get(login.toLowerCase()) ?? login;

	// Every team member, with their commit count (0 if none), ranked — not capped.
	const topAuthors = $derived.by(() => {
		// Rolling last-30d activity, so the board never resets at a month boundary.
		// Falls back to window sums only for a stale-cached result without the field.
		const recent = new Map((stats?.recentMembers ?? []).map((r) => [r.login.toLowerCase(), r]));
		const byAuthor = new Map<string, number>();
		if (recent.size === 0) {
			for (const a of stats?.authors ?? []) {
				const k = a.author.toLowerCase();
				byAuthor.set(k, (byAuthor.get(k) ?? 0) + a.commits);
			}
		}
		return (team?.members ?? [])
			.map((m) => {
				const k = m.login.toLowerCase();
				const commits = recent.size ? (recent.get(k)?.commits ?? 0) : (byAuthor.get(k) ?? 0);
				return [m.login, commits] as [string, number];
			})
			.sort((a, b) => b[1] - a[1]);
	});

	// Every team member's lines added/removed (merged PRs, last 30 days), ranked.
	const topLines = $derived.by(() => {
		const recent = new Map((stats?.recentMembers ?? []).map((r) => [r.login.toLowerCase(), r]));
		const byLogin = new Map(
			(stats?.linesByAuthor ?? []).map((l) => [l.author.toLowerCase(), l])
		);
		return (team?.members ?? [])
			.map((m) => {
				const l = recent.size ? recent.get(m.login.toLowerCase()) : byLogin.get(m.login.toLowerCase());
				const additions = l?.additions ?? 0;
				const deletions = l?.deletions ?? 0;
				return { author: m.login, additions, deletions, total: additions + deletions };
			})
			.sort((a, b) => b.total - a.total);
	});

	const hasRecent = $derived((stats?.recentMembers ?? []).length > 0);

	const lastRun = $derived(
		stats?.generatedAt
			? new Date(stats.generatedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
			: '—'
	);
</script>

<Topbar
	eyebrow="Overview"
	title="The state of {team?.name ?? 'the team'}."
	subtitle="Delivery velocity, review depth, and incoming quality signals for {team?.name ?? 'your team'}."
>
	{#snippet actions()}
		{#if stats}
			<Button variant="outline" size="lg" onclick={exportPdf}>
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
			<span class="text-sm">Loading metrics…</span>
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
				<Stat label="PRs merged · {heroPeriod}" value={hero.merged} trend={hero.trends.merged} hint={heroHint} size="lg" />
				<div class="mt-6"><MiniAreaChart values={mergedSpark} width={300} height={48} /></div>
			</div>
			<div class="col-span-6 md:col-span-3 md:border-l md:border-[var(--color-ink-300)] md:pl-8">
				<Stat label="PRs opened" value={hero.created} trend={hero.trends.created} size="md" />
				<div class="mt-5"><MiniAreaChart values={createdSpark} width={180} height={36} stroke="var(--color-info)" /></div>
			</div>
			<div class="col-span-6 md:col-span-2 md:border-l md:border-[var(--color-ink-300)] md:pl-8">
				<Stat label="Bugs raised" value={hero.bugs} trend={hero.trends.bugs} size="md" />
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
					<div class="eyebrow mb-2">Most active repositories · last 30 days</div>
					<h2 class="font-display text-[1.75rem] leading-none tracking-tight">Where the shipping happens</h2>
				</div>
				<a href="/charts" class="text-xs text-[var(--color-ink-700)] hover:text-[var(--color-brand)] inline-flex items-center gap-1">
					View all <ArrowUpRight class="h-3 w-3" />
				</a>
			</div>
			<Card.Root class="gap-0 py-0 overflow-hidden shadow-sm">
				{#each topRepos as r, i (r.repo)}
					<div class="group flex items-center gap-5 px-5 py-4 {i !== 0 ? 'border-t border-[var(--color-ink-200)]' : ''}">
						<span class="font-mono tabular text-xs text-[var(--color-ink-500)] w-6">{String(i + 1).padStart(2, '0')}</span>
						<div class="flex-1 min-w-0">
							<div class="font-display text-base text-[var(--color-ink-950)] truncate">{r.repo}</div>
							<div class="mt-0.5 font-mono text-[11px] text-[var(--color-ink-600)]">{r.created} created · {r.bugs} {r.bugs === 1 ? 'bug' : 'bugs'}</div>
						</div>
						<div class="text-right">
							<div class="font-display tabular text-2xl leading-none text-[var(--color-ink-950)]">{r.merged}</div>
							<div class="eyebrow mt-1.5">merged{#if r.delta !== 0}<span class="ml-1 {r.delta > 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}">{r.delta > 0 ? '+' : '−'}{Math.abs(r.delta)}</span>{/if}</div>
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
					<div class="eyebrow mb-2">Commit leaderboard · {hasRecent ? 'last 30 days' : `last ${scope.memberMonths}m`}</div>
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
									<div class="flex items-center justify-between gap-3 text-xs mb-1.5">
										<a href="/people/{name}" class="flex min-w-0 items-center gap-2 text-[var(--color-ink-900)] hover:text-[var(--color-brand)]">
											<Avatar login={name} name={displayName(name)} size={20} />
											<span class="truncate hover:underline">{displayName(name)}</span>
										</a>
										<span class="font-mono tabular shrink-0 text-[var(--color-ink-600)]">{fmtNum(count)}</span>
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
					<div class="eyebrow mb-2">Lines of code · merged PRs · {hasRecent ? 'last 30 days' : `last ${scope.memberMonths}m`}</div>
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
									<div class="flex items-center justify-between gap-3 text-xs mb-1.5">
										<a href="/people/{l.author}" class="flex min-w-0 items-center gap-2 text-[var(--color-ink-900)] hover:text-[var(--color-brand)]">
											<Avatar login={l.author} name={displayName(l.author)} size={20} />
											<span class="truncate hover:underline">{displayName(l.author)}</span>
										</a>
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

		<!-- MVP awards -->
		{#if awards.length}
			<section class="mt-16">
				<div class="mb-6">
					<div class="eyebrow mb-2">Standouts</div>
					<h2 class="font-display text-[1.75rem] leading-none tracking-tight">The MVPs.</h2>
					<p class="mt-2 max-w-xl text-sm text-[var(--color-ink-600)]">
						Who led the pack over the last 30 days, one trophy per stat.
					</p>
				</div>
				<div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
					{#each awards as a (a.key)}
						{@const Icon = awardIcon[a.key] ?? Trophy}
						<Card.Root class="gap-0 p-5 shadow-sm">
							<div class="flex items-center gap-2 text-[var(--color-ink-500)]">
								<Icon class="h-4 w-4" />
								<span class="eyebrow">{a.tagline}</span>
							</div>
							<div class="mt-2 font-display text-xl text-[var(--color-ink-950)]">{a.title}</div>
							<a
								href="/people/{a.login}"
								class="mt-3 flex items-center gap-2.5 hover:text-[var(--color-brand)]"
							>
								<Avatar login={a.login} name={a.name} size={36} />
								<div class="min-w-0">
									<div class="truncate text-sm font-medium text-[var(--color-ink-900)] hover:underline">
										{a.name}
									</div>
									<div class="font-mono text-xs text-[var(--color-ink-600)]">{a.stat}</div>
								</div>
							</a>
						</Card.Root>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Cadence -->
		{#if allMonthly.length > 0}
			{@const maxBar = Math.max(...allMonthly.map(([, v]) => v.merged), 1)}
			<section class="mt-16">
				<div class="mb-6">
					<div class="eyebrow mb-2">Historical trend · merged per month · last {scope.months}m</div>
					<h2 class="font-display text-[1.75rem] leading-none tracking-tight">Merged PRs, month by month</h2>
					<p class="mt-2 max-w-xl text-sm text-[var(--color-ink-600)]">
						Long-range history for context. Each bar is the number of pull requests the team merged that month;
						the dimmed last bar is the current month so far. Current-state numbers above are a rolling 30-day view.
					</p>
				</div>
				<Card.Root class="p-8 shadow-sm">
					<div class="flex items-end justify-between gap-2 h-52 border-b border-[var(--color-ink-200)]">
						{#each allMonthly as [month, v] (month)}
							{@const mtd = month === currentMonthKey}
							<div class="flex-1 flex flex-col items-center gap-1.5 group cursor-default" title={mtd ? `${fmtMonth(month)} — month to date` : fmtMonth(month)}>
								<div class="font-mono tabular text-[11px] {mtd ? 'text-[var(--color-ink-500)]' : 'text-[var(--color-ink-700)]'} group-hover:text-[var(--color-ink-950)]">{v.merged}</div>
								<div
									class="w-full rounded-t-sm transition-all {mtd
										? 'bg-[var(--color-brand)]/30 border border-b-0 border-dashed border-[var(--color-brand)]/60 group-hover:bg-[var(--color-brand)]/40'
										: 'bg-[var(--color-brand)]/80 group-hover:bg-[var(--color-brand)]'}"
									style:height={`${Math.max((v.merged / maxBar) * 150, 2)}px`}
								></div>
							</div>
						{/each}
					</div>
					<div class="flex justify-between gap-2 pt-2">
						{#each allMonthly as [month] (month)}
							{@const mtd = month === currentMonthKey}
							<div class="flex-1 text-center text-[10px] font-mono uppercase tracking-wider {mtd ? 'text-[var(--color-ink-500)]' : 'text-[var(--color-ink-600)]'}">
								{fmtMonth(month)}{#if mtd}<span class="block text-[8px] tracking-widest text-[var(--color-brand)]">MTD</span>{/if}
							</div>
						{/each}
					</div>
				</Card.Root>
			</section>
		{/if}
	{/if}
</div>
