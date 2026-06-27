<script lang="ts">
	import Topbar from '$lib/components/Topbar.svelte';
	import * as Card from '$lib/components/ui/card';
	import { ShieldAlert } from '@lucide/svelte';

	let { data } = $props();

	const fmtTs = (ts: string | Date) =>
		new Date(ts).toLocaleString('en-GB', {
			day: '2-digit',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});

	const statusClass = (s: number | null) => {
		if (s == null) return 'text-[var(--color-ink-500)]';
		if (s >= 500) return 'text-[var(--color-negative)]';
		if (s >= 400) return 'text-[var(--color-warn)]';
		return 'text-[var(--color-positive)]';
	};
</script>

<svelte:head><title>Logs · team·health</title></svelte:head>

<Topbar eyebrow="Logs" title="Activity & security log." subtitle="Per-user events across the app, newest first." />

<div class="px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
	<!-- Filters (server-side via query params); global across the app, not team-scoped. -->
	<form method="GET" class="mb-6 flex flex-wrap items-end gap-4 rounded-xl border border-[var(--color-ink-200)] bg-[var(--color-card)] p-4">
		<label class="flex w-44 flex-col gap-1.5">
			<span class="eyebrow">Kind</span>
			<select name="kind" class="h-9 rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] px-2.5 text-sm">
				<option value="" selected={data.filter.kind === ''}>All</option>
				<option value="http" selected={data.filter.kind === 'http'}>Requests</option>
				<option value="action" selected={data.filter.kind === 'action'}>Actions</option>
				<option value="security" selected={data.filter.kind === 'security'}>Security</option>
			</select>
		</label>
		<label class="flex min-w-[200px] flex-1 flex-col gap-1.5">
			<span class="eyebrow">User</span>
			<input
				name="user"
				value={data.filter.user}
				placeholder="email or id"
				class="h-9 rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] px-2.5 text-sm"
			/>
		</label>
		<label class="mb-1.5 inline-flex items-center gap-2 text-sm text-[var(--color-ink-800)]">
			<input type="checkbox" name="suspicious" value="true" checked={data.filter.suspicious} />
			Suspicious only
		</label>
		<button
			type="submit"
			class="h-9 rounded-lg bg-[var(--color-brand)] px-4 text-sm font-medium text-white hover:opacity-90"
		>
			Filter
		</button>
	</form>

	<Card.Root class="overflow-hidden p-0 shadow-sm">
		{#if data.events.length === 0}
			<div class="py-16 text-center text-sm text-[var(--color-ink-600)]">No events match.</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-xs">
					<thead class="border-b border-[var(--color-ink-200)] text-[var(--color-ink-500)]">
						<tr>
							<th class="px-4 py-2.5 font-medium">Time</th>
							<th class="px-4 py-2.5 font-medium">User</th>
							<th class="px-4 py-2.5 font-medium">Kind</th>
							<th class="px-4 py-2.5 font-medium">Action</th>
							<th class="px-4 py-2.5 font-medium">Status</th>
							<th class="px-4 py-2.5 text-right font-medium">ms</th>
							<th class="px-4 py-2.5 font-medium">IP</th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each data.events as e (e.id)}
							<tr
								class="border-b border-[var(--color-ink-100)] {e.suspicious
									? 'bg-[var(--color-negative)]/5'
									: ''}"
							>
								<td class="whitespace-nowrap px-4 py-2 text-[var(--color-ink-600)]">{fmtTs(e.ts)}</td>
								<td class="max-w-[160px] truncate px-4 py-2 text-[var(--color-ink-800)]" title={e.userEmail ?? e.userSub}>
									{e.userEmail ?? e.userSub}
								</td>
								<td class="px-4 py-2">
									{#if e.suspicious}
										<span class="inline-flex items-center gap-1 text-[var(--color-negative)]">
											<ShieldAlert class="h-3 w-3" />{e.kind}
										</span>
									{:else}
										<span class="text-[var(--color-ink-600)]">{e.kind}</span>
									{/if}
								</td>
								<td class="max-w-[280px] truncate px-4 py-2 text-[var(--color-ink-900)]" title={e.action}>{e.action}</td>
								<td class="px-4 py-2 tabular {statusClass(e.status)}">{e.status ?? '—'}</td>
								<td class="px-4 py-2 text-right tabular text-[var(--color-ink-600)]">{e.durationMs ?? '—'}</td>
								<td class="px-4 py-2 text-[var(--color-ink-500)]">{e.ip ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</Card.Root>
	<p class="mt-3 text-[11px] text-[var(--color-ink-500)]">Showing the most recent {data.events.length} events.</p>
</div>
