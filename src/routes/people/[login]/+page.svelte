<script lang="ts">
	import { page } from '$app/state';
	import Topbar from '$lib/components/Topbar.svelte';
	import * as Card from '$lib/components/ui/card';
	import { metrics, selectionFor } from '$lib/client/metrics.svelte';
	import { person } from '$lib/client/person.svelte';
	import { scope } from '$lib/client/scope.svelte';
	import { fmtNum } from '$lib/utils';
	import { withoutEmptyCurrentMonth } from '$lib/months';
	import MetricChart from '$lib/components/charts/MetricChart.svelte';
	import { Loader2, ArrowLeft, AlertCircle } from '@lucide/svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import { DEFAULT_TARGETS, type SignalLevel } from '$lib/signals';

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

	// The member window tracks the top bar's period up to a cap. When the period is
	// longer, say so rather than letting "last 12 months" pass for the 24 asked for.
	// Gated on `initialized`: before the scope store loads, months and memberMonths
	// still hold unrelated defaults, and SSR would render a "capped" the user never
	// asked for and that hydration then silently corrects.
	const capped = $derived(scope.initialized && scope.memberMonths < scope.months);
	const windowLabel = $derived(
		`last ${scope.memberMonths} months + this month${capped ? ` (capped from ${scope.months})` : ''}`
	);

	// Per-person health rollup: grade this member against the same admin-tunable
	// thresholds the team Signals page uses, so the profile shows their individual
	// standing on burnout (timing) and workload (volume).
	const targets = $derived(page.data.signals ?? DEFAULT_TARGETS);
	const teamCommits = $derived((stats?.authors ?? []).reduce((s, a) => s + a.commits, 0));
	const teamContributors = $derived(new Set((stats?.authors ?? []).map((a) => a.author)).size);
	const workloadPct = $derived(teamCommits ? Math.round((totalCommits / teamCommits) * 100) : 0);
	const lvl = (v: number, warn: number, bad: number): SignalLevel => (v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok');
	// Timing shares are noise on tiny commit counts, so only grade them past the same
	// floor the team-level burnout signal uses; below it, show the number unjudged.
	const enoughCommits = $derived((pattern?.commits ?? 0) >= targets.burnoutMinCommits);
	const health = $derived([
		{
			label: 'Weekend commits',
			value: `${weekendPct}%`,
			level: lvl(weekendPct, targets.weekendWarnPct, targets.weekendBadPct),
			muted: !enoughCommits,
			note: enoughCommits ? `${fmtNum(pattern?.weekendCommits ?? 0)} on Sat/Sun, local` : 'too few commits to judge'
		},
		{
			label: 'Late-night commits',
			value: `${lateNightPct}%`,
			level: lvl(lateNightPct, targets.lateNightWarnPct, targets.lateNightBadPct),
			muted: !enoughCommits,
			note: enoughCommits ? `${fmtNum(pattern?.lateNightCommits ?? 0)} after 10pm, local` : 'too few commits to judge'
		},
		{
			label: 'Share of team commits',
			value: `${workloadPct}%`,
			level: lvl(workloadPct, targets.workloadShareWarnPct, targets.workloadShareBadPct),
			// Don't grade a share the team Signals page would suppress: too few
			// contributors or too little total work to read concentration into.
			muted: teamContributors < targets.minContributors || teamCommits < targets.workloadMinTotal,
			note: `${fmtNum(totalCommits)} of ${fmtNum(teamCommits)} team commits`
		}
	]);
	// Matches the Signals page accent scheme (amber-700 for warn keeps >= 4.5:1 contrast).
	const accent: Record<SignalLevel, string> = {
		bad: 'var(--color-negative)',
		warn: '#b45309',
		ok: 'var(--color-positive)'
	};

	const hasActivity = $derived(totalCommits > 0 || merged > 0 || review.reviews > 0 || lines.additions + lines.deletions > 0);

	// ---- Deep per-person report (/api/person) --------------------------------
	// Loaded here rather than by the scope store: it is the only page that needs
	// it, and it keys off the same Selection the team report uses so both resolve
	// the identical window and roster.
	$effect(() => {
		const t = scope.activeTeam;
		// `member` gates the call: the endpoint only reports on someone in the
		// submitted roster, so an unknown login in the URL would be a 400.
		if (!scope.initialized || !t?.repos.length || !member) return;
		person.ensure(
			selectionFor(t, scope.months, scope.memberMonths, scope.to || undefined),
			member.login
		);
	});

	const p = $derived(person.data?.login.toLowerCase() === lc(login) ? person.data : null);
	const totals = $derived(p?.totals);
	const byMonth = $derived(p?.byMonth ?? []);

	// Hours -> friendly duration, and the null medians the server withholds when
	// the sample is too small to describe a person.
	const dur = (h: number | null | undefined) =>
		h === null || h === undefined ? '—' : h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
	const orDash = (n: number | null | undefined) => (n === null || n === undefined ? '—' : fmtNum(n));
	const TOO_FEW = 'too few PRs to judge';

	const delivery = $derived(
		totals
			? [
					{ label: 'PRs opened', value: fmtNum(totals.prsCreated), note: `${fmtNum(totals.prsMerged)} merged, ${fmtNum(totals.prsClosedUnmerged)} dropped` },
					{ label: 'Merge rate', value: totals.mergeRatePct === null ? '—' : `${totals.mergeRatePct}%`, note: totals.mergeRatePct === null ? 'they have closed no PRs yet' : 'of the PRs they closed' },
					{ label: 'Median PR size', value: orDash(totals.medianPrSize), note: totals.medianPrSize === null ? TOO_FEW : 'lines changed, merged PRs' },
					{ label: 'Median cycle time', value: dur(totals.medianCycleHours), note: totals.medianCycleHours === null ? TOO_FEW : 'open to merge, their PRs' }
				]
			: []
	);
	const reviewing = $derived(
		totals
			? [
					{ label: 'PRs reviewed', value: fmtNum(totals.prsReviewed), note: `${fmtNum(totals.reviewsGiven)} reviews, ${fmtNum(totals.commentsGiven)} comments` },
					{ label: 'Approvals', value: fmtNum(totals.approvals), note: 'reviews that signed off' },
					{ label: 'Changes requested', value: fmtNum(totals.changesRequested), note: 'reviews that sent work back' },
					{ label: 'Median pickup', value: dur(totals.medianPickupHours), note: totals.medianPickupHours === null ? TOO_FEW : 'PR open to their first review' }
				]
			: []
	);
	const received = $derived(
		totals
			? [
					{ label: 'Reviewers', value: fmtNum(totals.reviewersDistinct), note: `${fmtNum(totals.reviewsReceived)} reviews on their PRs` },
					{ label: 'Median wait', value: dur(totals.medianWaitHours), note: totals.medianWaitHours === null ? TOO_FEW : 'their PRs, open to first review' },
					{ label: 'Merged unreviewed', value: fmtNum(totals.unreviewedMerges), note: 'no human review before merge' }
				]
			: []
	);

	// Peer names come from the roster; a non-member counterpart keeps its login.
	const nameOf = $derived(
		new Map((team?.members ?? []).map((m) => [lc(m.login), m.name]))
	);
	const peers = $derived((p?.peers ?? []).slice(0, 8));
	const peerMax = $derived(Math.max(1, ...peers.map((x) => Math.max(x.given, x.received))));

	// Charts. Each panel holds series that share one scale, so none of them needs
	// a second y-axis: commits and PR counts live on separate panels rather than
	// one chart where the commit line would flatten the PR line into the floor.
	// The trailing in-progress month is dropped when it is still empty, so a month
	// that has not happened yet doesn't draw as a collapse to zero.
	const activity = $derived(withoutEmptyCurrentMonth(byMonth, (m) => m.commits > 0));
	const prs = $derived(withoutEmptyCurrentMonth(byMonth, (m) => m.prsCreated > 0 || m.prsMerged > 0));
	const reviewSeries = $derived(
		withoutEmptyCurrentMonth(byMonth, (m) => m.reviewsGiven > 0 || m.commentsGiven > 0 || m.reviewsReceived > 0)
	);
	const volume = $derived(withoutEmptyCurrentMonth(byMonth, (m) => m.additions > 0 || m.deletions > 0));
	// A month with nothing merged has no median, and plotting it as 0h would draw
	// the quietest month as the fastest one — so it stays null and the line gaps
	// there. The month itself keeps its place on the axis: dropping quiet rows is
	// what made neighbouring months slide together as though they were adjacent
	// (see the bot chart fix, #112). Only the trailing in-progress month is
	// dropped, and only while it is still empty.
	const timing = $derived(
		withoutEmptyCurrentMonth(byMonth, (m) => m.cycleHours !== null || m.pickupHours !== null)
	);
	const hasTrend = $derived(byMonth.some((m) => m.commits || m.prsCreated || m.prsMerged || m.reviewsGiven || m.commentsGiven || m.reviewsReceived));
</script>

<svelte:head><title>{name} · team·health</title></svelte:head>

<Topbar eyebrow="Profile" title={name} subtitle="{login} · {team?.name ?? 'team'} · {windowLabel}">
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
			</section>

			<!-- Delivery / review depth, from the per-person report. Each row is the
			     same neutral stat idiom as the headline above, so the page reads as
			     one page rather than a dashboard bolted onto a profile. -->
			{#if person.error}
				<Card.Root class="mb-12 p-6 text-center text-sm text-[var(--color-ink-600)] shadow-sm">
					Could not load delivery and review detail: <span class="font-mono text-xs">{person.error}</span>
				</Card.Root>
			{:else if !p && person.loading}
				<div class="mb-12 flex items-center gap-3 py-10 text-sm text-[var(--color-ink-600)]">
					<Loader2 class="h-4 w-4 animate-spin text-[var(--color-brand)]" />
					Loading delivery and review detail…
				</div>
			{:else if p}
				{#snippet statRow(items: { label: string; value: string; note: string }[])}
					<div class="grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
						{#each items as s (s.label)}
							<div>
								<div class="eyebrow mb-2">{s.label}</div>
								<div class="font-display tabular text-4xl leading-none text-[var(--color-ink-950)]">{s.value}</div>
								<div class="mt-2 font-mono text-xs text-[var(--color-ink-600)]">{s.note}</div>
							</div>
						{/each}
					</div>
				{/snippet}

				<section class="mb-12">
					<div class="mb-6">
						<div class="eyebrow mb-2">Delivery</div>
						<h3 class="font-display text-[1.75rem] leading-none tracking-tight">How they ship</h3>
					</div>
					{@render statRow(delivery)}
				</section>

				<section class="mb-12">
					<div class="mb-6">
						<div class="eyebrow mb-2">Review</div>
						<h3 class="font-display text-[1.75rem] leading-none tracking-tight">Review they give</h3>
					</div>
					{@render statRow(reviewing)}
				</section>

				<section class="mb-12">
					<div class="mb-6">
						<div class="eyebrow mb-2">Review</div>
						<h3 class="font-display text-[1.75rem] leading-none tracking-tight">Review they receive</h3>
					</div>
					{@render statRow(received)}
				</section>
			{/if}

			<!-- Health signals: this member graded against the team's thresholds -->
			<section class="mb-12">
				<div class="mb-6">
					<div class="eyebrow mb-2">Health signals</div>
					<h3 class="font-display text-[1.75rem] leading-none tracking-tight">Burnout & workload</h3>
				</div>
				<div class="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3">
					{#each health as h (h.label)}
						{@const flagged = !h.muted && h.level !== 'ok'}
						<div>
							<div class="eyebrow mb-2">{h.label}</div>
							<div class="flex items-baseline gap-2">
								<span class="font-display tabular text-4xl leading-none text-[var(--color-ink-950)]">{h.value}</span>
								{#if flagged}
									<!-- Status is a small accent, not a fully colored card, so the section
									     stays consistent with the neutral stat cards above. -->
									<span
										class="rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em]"
										style="color: {accent[h.level]}; background: color-mix(in oklab, {accent[h.level]} 14%, transparent)"
									>
										{h.level === 'bad' ? 'High' : 'Elevated'}
									</span>
								{/if}
							</div>
							<div class="mt-2 font-mono text-xs text-[var(--color-ink-600)]">{h.note}</div>
						</div>
					{/each}
				</div>
			</section>

			<!-- Trends. Panels are split by unit, not by topic: commits, PR counts,
			     review counts, hours and lines each get their own scale rather than
			     sharing one chart with a second y-axis. -->
			{#if p && hasTrend}
				<section class="mb-12">
					<div class="mb-6">
						<div class="eyebrow mb-2">Over time</div>
						<h3 class="font-display text-[1.75rem] leading-none tracking-tight">Trends</h3>
					</div>
					<div class="grid gap-6 lg:grid-cols-2">
						<Card.Root class="p-6 shadow-sm">
							<div class="mb-4">
								<div class="font-display text-lg leading-none">Commits</div>
								<div class="mt-1.5 text-xs text-[var(--color-ink-600)]">Commits authored, per month.</div>
							</div>
							<MetricChart
								data={activity}
								x="month"
								kind="bar"
								legend={false}
								series={[{ key: 'commits', label: 'Commits', color: 'var(--color-chart-1)' }]}
								class="aspect-[5/2] w-full"
							/>
						</Card.Root>

						<Card.Root class="p-6 shadow-sm">
							<div class="mb-4">
								<div class="font-display text-lg leading-none">Pull requests</div>
								<div class="mt-1.5 text-xs text-[var(--color-ink-600)]">PRs they opened, and PRs of theirs that merged.</div>
							</div>
							<MetricChart
								data={prs}
								x="month"
								kind="line"
								series={[
									{ key: 'prsCreated', label: 'Opened', color: 'var(--color-chart-2)' },
									{ key: 'prsMerged', label: 'Merged', color: 'var(--color-chart-1)' }
								]}
								class="aspect-[5/2] w-full"
							/>
						</Card.Root>

						<Card.Root class="p-6 shadow-sm">
							<div class="mb-4">
								<div class="font-display text-lg leading-none">Review activity</div>
								<div class="mt-1.5 text-xs text-[var(--color-ink-600)]">Review they gave, and review their own PRs drew.</div>
							</div>
							<MetricChart
								data={reviewSeries}
								x="month"
								kind="line"
								series={[
									{ key: 'reviewsGiven', label: 'Reviews given', color: 'var(--color-chart-1)' },
									{ key: 'commentsGiven', label: 'Comments given', color: 'var(--color-chart-3)' },
									{ key: 'reviewsReceived', label: 'Reviews received', color: 'var(--color-chart-4)' }
								]}
								class="aspect-[5/2] w-full"
							/>
						</Card.Root>

						<Card.Root class="p-6 shadow-sm">
							<div class="mb-4">
								<div class="font-display text-lg leading-none">Cycle time</div>
								<div class="mt-1.5 text-xs text-[var(--color-ink-600)]">Median hours: their PRs open to merge, and how fast they pick up a review.</div>
							</div>
							{#if timing.length}
								<MetricChart
									data={timing}
									x="month"
									kind="line"
									series={[
										{ key: 'cycleHours', label: 'Open to merge', color: 'var(--color-chart-1)' },
										{ key: 'pickupHours', label: 'Their review pickup', color: 'var(--color-chart-3)' }
									]}
									class="aspect-[5/2] w-full"
								/>
							{:else}
								<div class="flex aspect-[5/2] items-center justify-center text-sm text-[var(--color-ink-600)]">
									Nothing merged or reviewed in this window
								</div>
							{/if}
						</Card.Root>

						<Card.Root class="p-6 shadow-sm lg:col-span-2">
							<div class="mb-4">
								<div class="font-display text-lg leading-none">Code volume</div>
								<div class="mt-1.5 text-xs text-[var(--color-ink-600)]">Lines added and removed by their merged PRs, per month.</div>
							</div>
							<MetricChart
								data={volume}
								x="month"
								kind="area"
								seriesLayout="overlap"
								series={[
									{ key: 'additions', label: 'Additions', color: 'var(--color-chart-3)' },
									{ key: 'deletions', label: 'Deletions', color: 'var(--color-chart-4)' }
								]}
								class="aspect-[5/2] w-full lg:aspect-[5/1.4]"
							/>
						</Card.Root>
					</div>
				</section>
			{/if}

			<!-- Collaboration: who this person exchanges review with, both ways. -->
			{#if p && peers.length}
				<section class="mb-12">
					<div class="mb-6">
						<div class="eyebrow mb-2">Collaboration</div>
						<h3 class="font-display text-[1.75rem] leading-none tracking-tight">Who they review with</h3>
					</div>
					<Card.Root class="p-6 shadow-sm">
						<div class="mb-4 flex items-center justify-end gap-5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-700)]">
							<span class="flex items-center gap-2">
								<span class="h-2 w-2 rounded-[2px] bg-[var(--color-chart-1)]"></span> Reviews they gave
							</span>
							<span class="flex items-center gap-2">
								<span class="h-2 w-2 rounded-[2px] bg-[var(--color-chart-4)]"></span> Reviews they got
							</span>
						</div>
						<ul class="space-y-4">
							{#each peers as peer (peer.login)}
								<li>
									<div class="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
										<a href="/people/{peer.login}" class="flex items-center gap-2 text-[var(--color-ink-800)] hover:text-[var(--color-brand)]">
											<Avatar login={peer.login} name={nameOf.get(lc(peer.login)) ?? peer.login} size={20} />
											<span>{nameOf.get(lc(peer.login)) ?? peer.login}</span>
										</a>
										<span class="font-mono tabular text-[var(--color-ink-600)]">
											{fmtNum(peer.given)} given · {fmtNum(peer.received)} received
										</span>
									</div>
									<!-- Two stacked bars rather than one: the direction of the
									     exchange is the point, and a single bar would hide it. -->
									<div class="space-y-1">
										<div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-ink-200)]">
											<div class="h-full rounded-full bg-[var(--color-chart-1)]" style:width={`${(peer.given / peerMax) * 100}%`}></div>
										</div>
										<div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-ink-200)]">
											<div class="h-full rounded-full bg-[var(--color-chart-4)]" style:width={`${(peer.received / peerMax) * 100}%`}></div>
										</div>
									</div>
								</li>
							{/each}
						</ul>
					</Card.Root>
				</section>
			{/if}

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
