<script lang="ts">
	import { scope } from '$lib/client/scope.svelte';
	import { theme } from '$lib/client/theme.svelte';
	import { signOut } from '@auth/sveltekit/client';
	import * as Select from '$lib/components/ui/select';
	import MonthRangePicker from '$lib/components/MonthRangePicker.svelte';
	import { Users, GitBranch, RefreshCw, Settings2, Power, Menu, Sun, Moon } from '@lucide/svelte';
	import { onMount } from 'svelte';

	onMount(() => theme.init());

	let {
		user,
		authEnabled,
		busy = false,
		onRefresh,
		onMenu
	}: {
		user: { name: string; email: string };
		authEnabled: boolean;
		busy?: boolean;
		onRefresh?: () => void;
		onMenu?: () => void;
	} = $props();

	const active = $derived(scope.activeTeam);
	const initials = $derived(
		(user?.name || user?.email || '?')
			.split(/[\s@.]+/)
			.slice(0, 2)
			.map((s) => s[0]?.toUpperCase() ?? '')
			.join('')
	);
</script>

<div class="flex flex-wrap items-center gap-2 border-b border-[var(--color-ink-300)] bg-[var(--color-ink-0)]/70 px-4 py-2.5 backdrop-blur-xl sm:px-6 lg:h-16 lg:flex-nowrap lg:gap-3 lg:px-10 lg:py-0 print:hidden">
	<button
		class="-ml-1 rounded-md p-1.5 text-[var(--color-ink-700)] hover:bg-[var(--color-ink-100)] lg:hidden"
		aria-label="Open menu"
		onclick={() => onMenu?.()}
	>
		<Menu class="h-5 w-5" />
	</button>
	<span class="eyebrow hidden md:inline">Scope</span>

	<!-- Team picker -->
	<Select.Root type="single" value={scope.activeTeamId} onValueChange={(v) => v && scope.setTeam(v)}>
		<Select.Trigger class="h-8 min-w-[150px] bg-[var(--color-card)]">
			{active?.name}{active?.builtin ? ' (default)' : ''}
		</Select.Trigger>
		<Select.Content>
			{#each scope.teams as t (t.id)}
				<Select.Item value={t.id} label={t.name}>{t.name}{t.builtin ? ' (default)' : ''}</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>

	<!-- Range picker: any From → To window, at month granularity -->
	<MonthRangePicker
		from={scope.rangeFrom}
		to={scope.rangeTo}
		onChange={(f, t) => scope.setRange(f, t)}
	/>

	<div class="hidden items-center gap-4 text-xs text-[var(--color-ink-600)] lg:flex">
		<span class="inline-flex items-center gap-1.5">
			<GitBranch class="h-3.5 w-3.5" />
			<span class="font-mono tabular text-[var(--color-ink-900)]">{active?.repos.length ?? 0}</span> repos
		</span>
		<span class="inline-flex items-center gap-1.5">
			<Users class="h-3.5 w-3.5" />
			<span class="font-mono tabular text-[var(--color-ink-900)]">{active?.members.length ?? 0}</span> members
		</span>
	</div>

	<div class="ml-auto flex items-center gap-2">
		<button
			onclick={() => theme.toggle()}
			class="rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] p-1.5 text-[var(--color-ink-600)] hover:border-[var(--color-ink-400)] hover:text-[var(--color-ink-900)]"
			aria-label="Toggle dark mode"
			title={theme.current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
		>
			{#if theme.current === 'dark'}<Sun class="h-4 w-4" />{:else}<Moon class="h-4 w-4" />{/if}
		</button>
		<a
			href="/teams"
			class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] px-2.5 py-1.5 text-xs text-[var(--color-ink-800)] hover:border-[var(--color-ink-400)]"
		>
			<Settings2 class="h-3.5 w-3.5" /> <span class="hidden sm:inline">Manage teams</span>
		</a>
		<button
			onclick={() => onRefresh?.()}
			disabled={busy}
			class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] px-2.5 py-1.5 text-xs text-[var(--color-ink-800)] hover:border-[var(--color-ink-400)] disabled:opacity-50"
		>
			<RefreshCw class="h-3.5 w-3.5 {busy ? 'animate-spin' : ''}" /> <span class="hidden sm:inline">Refresh</span>
		</button>

		<!-- User + logout -->
		{#if user}
			<div class="ml-1 flex items-center gap-2.5 border-l border-[var(--color-ink-300)] pl-3">
				<div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-ink-200)] font-mono text-[10px] text-[var(--color-ink-700)]">
					{initials}
				</div>
				<div class="hidden min-w-0 leading-tight sm:block">
					<div class="truncate text-xs text-[var(--color-ink-900)]">{user.name || user.email}</div>
					{#if user.name && user.email}<div class="truncate text-[11px] text-[var(--color-ink-500)]">{user.email}</div>{/if}
				</div>
				<button
					onclick={() => authEnabled && signOut()}
					disabled={!authEnabled}
					class="rounded-lg border border-[var(--color-ink-300)] p-1.5 text-[var(--color-ink-600)] hover:border-[var(--color-negative)]/40 hover:bg-[var(--color-negative)]/10 hover:text-[var(--color-negative)] disabled:cursor-default disabled:opacity-40 disabled:hover:border-[var(--color-ink-300)] disabled:hover:bg-transparent disabled:hover:text-[var(--color-ink-600)]"
					aria-label="Sign out"
					title={authEnabled ? 'Sign out' : 'Sign-out is available once SSO (OIDC) is configured'}
				>
					<Power class="h-4 w-4" />
				</button>
			</div>
		{/if}
	</div>
</div>
