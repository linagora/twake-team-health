<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import * as Card from '$lib/components/ui/card';
	import Avatar from '$lib/components/Avatar.svelte';
	import { flow } from '$lib/client/flow.svelte';
	import { scope } from '$lib/client/scope.svelte';
	import { fmtNum } from '$lib/utils';
	import { AlertCircle, Loader2 } from '@lucide/svelte';

	const team = $derived(scope.activeTeam);

	// Bot activity rides on the Flow report (same query, reusing its cache).
	$effect(() => {
		const t = scope.activeTeam;
		if (t?.repos.length) flow.ensure(t.repos, scope.months, scope.to || undefined);
	});

	const bots = $derived(flow.data?.botActivity ?? []);
	const ready = $derived(!!flow.data);
	const maxTotal = $derived(Math.max(...bots.map((b) => b.reviews + b.comments), 1));
</script>

<Topbar
	eyebrow="Bots"
	title="The robots."
	subtitle="Automated review activity on {team?.name ?? 'your team'}'s merged PRs."
/>

<div class="px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
	{#if flow.error}
		<Card.Root class="p-10 text-center shadow-sm">
			<AlertCircle class="mx-auto h-9 w-9 text-[var(--color-negative)]" />
			<p class="mt-3 font-mono text-xs text-[var(--color-ink-600)]">{flow.error}</p>
		</Card.Root>
	{:else if !ready && flow.loading}
		<div class="flex items-center justify-center gap-3 py-32 text-[var(--color-ink-600)]">
			<Loader2 class="h-5 w-5 animate-spin text-[var(--color-brand)]" />
			<span class="text-sm">Loading bot activity…</span>
		</div>
	{:else if ready}
		{#if bots.length === 0}
			<Card.Root class="p-12 text-center text-sm text-[var(--color-ink-600)] shadow-sm">
				No automated reviewers on this team's merged PRs.
			</Card.Root>
		{:else}
			<div class="grid grid-cols-1 gap-5 md:grid-cols-2">
				{#each bots as b (b.login)}
					{@const total = b.reviews + b.comments}
					<Card.Root class="gap-0 p-6 shadow-sm">
						<div class="flex items-center gap-3.5">
							<Avatar login={b.login} name={b.login} srcUrl={b.avatarUrl} size={44} />
							<div class="min-w-0">
								<a
									href="https://github.com/apps/{b.login}"
									target="_blank"
									rel="noopener noreferrer"
									class="block truncate font-display text-lg text-[var(--color-ink-950)] hover:text-[var(--color-brand)] hover:underline"
								>
									{b.login}
								</a>
								<div class="font-mono text-[11px] text-[var(--color-ink-500)]">{fmtNum(total)} total</div>
							</div>
						</div>
						<!-- Hide Reviews for comment-only bots (a 0 there is just noise). -->
						<div class="mt-5 grid gap-3 {b.reviews > 0 ? 'grid-cols-3' : 'grid-cols-2'}">
							{#if b.reviews > 0}
								<div>
									<div class="font-mono tabular text-xl text-[var(--color-ink-950)]">{fmtNum(b.reviews)}</div>
									<div class="eyebrow mt-0.5">Reviews</div>
								</div>
							{/if}
							<div>
								<div class="font-mono tabular text-xl text-[var(--color-ink-950)]">{fmtNum(b.comments)}</div>
								<div class="eyebrow mt-0.5">Comments</div>
							</div>
							<div>
								<div class="font-mono tabular text-xl text-[var(--color-ink-950)]">
									{b.prs ? (b.comments / b.prs).toFixed(1) : '0'}
								</div>
								<div class="eyebrow mt-0.5">Comments/PR</div>
							</div>
						</div>
						<div class="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-ink-200)]">
							<div
								class="h-full rounded-full bg-[var(--color-brand)]"
								style:width={`${(total / maxTotal) * 100}%`}
							></div>
						</div>
					</Card.Root>
				{/each}
			</div>
		{/if}
	{/if}
</div>
