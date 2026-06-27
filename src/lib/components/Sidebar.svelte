<script lang="ts">
	import { page } from '$app/state';
	import { LayoutDashboard, Users, BarChart3, Globe, X, TriangleAlert, Gauge, Layers, Cog, Activity, Bot, ScrollText } from '@lucide/svelte';
	import linagoraLogo from '$lib/assets/linagora-logo.svg';
	import twakeLogo from '$lib/assets/twake-logo.svg';

	let {
		open = false,
		onClose,
		isAdmin = false,
		orgName = ''
	}: { open?: boolean; onClose?: () => void; isAdmin?: boolean; orgName?: string } = $props();

	const nav = $derived([
		// Big-picture views first (Overview, Global), then team-scoped detail
		// (Attention, Flow, Charts), then team management, then admin settings.
		{ href: '/', label: 'Overview', icon: LayoutDashboard, kbd: '01' },
		{ href: '/signals', label: 'Signals', icon: Activity, kbd: '02' },
		{ href: '/global', label: 'Global', icon: Globe, kbd: '03' },
		{ href: '/breakdown', label: 'Breakdown', icon: Layers, kbd: '04' },
		{ href: '/attention', label: 'Attention', icon: TriangleAlert, kbd: '05' },
		{ href: '/flow', label: 'Flow', icon: Gauge, kbd: '06' },
		{ href: '/charts', label: 'Charts', icon: BarChart3, kbd: '07' },
		{ href: '/teams', label: 'Teams', icon: Users, kbd: '08' },
		{ href: '/bots', label: 'Bots', icon: Bot, kbd: '09' },
		...(isAdmin
			? [
					{ href: '/logs', label: 'Logs', icon: ScrollText, kbd: '10' },
					{ href: '/settings', label: 'Settings', icon: Cog, kbd: '11' }
				]
			: [])
	]);
</script>

<!-- Off-canvas drawer below lg; a static rail at lg and up. -->
<aside
	class="fixed inset-y-0 left-0 z-50 flex h-screen w-[240px] shrink-0 transform flex-col border-r border-[var(--color-ink-300)] bg-[var(--color-ink-0)] transition-transform duration-200 lg:sticky lg:top-0 lg:z-auto lg:translate-x-0 lg:bg-[var(--color-ink-0)]/60 lg:backdrop-blur-xl lg:transition-none print:hidden {open
		? 'translate-x-0 shadow-2xl'
		: '-translate-x-full lg:translate-x-0'}">
	<div class="flex h-16 items-center justify-between border-b border-[var(--color-ink-300)] px-6">
		<div class="flex items-center gap-2.5">
			<div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-brand)]">
				<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M3 13h3l2 5 4-12 2 7h4" />
				</svg>
			</div>
			<div>
				<div class="font-display text-[1.25rem] leading-none tracking-tight text-[var(--color-ink-950)]">
					team<span class="text-[var(--color-brand)]">·</span>health
				</div>
				<div class="eyebrow mt-1 max-w-[150px] truncate">{orgName || 'Engineering metrics'}</div>
			</div>
		</div>
		<button class="rounded-md p-1.5 text-[var(--color-ink-600)] hover:bg-[var(--color-ink-100)] lg:hidden" aria-label="Close menu" onclick={() => onClose?.()}>
			<X class="h-5 w-5" />
		</button>
	</div>

	<!-- The nav is always on screen, so preload each section's JS chunk as soon as
	     it's in the viewport; combined with the body's preload-data="hover" this
	     makes section switches instant even on a first click without hovering. -->
	<nav class="flex-1 px-3 py-5" data-sveltekit-preload-code="viewport">
		<div class="eyebrow mb-3 px-4">Navigate</div>
		<ul class="space-y-0.5">
			{#each nav as item (item.href)}
				{@const Icon = item.icon}
				{@const active = item.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(item.href)}
				<li>
					<a
						href={item.href}
						class="group relative flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm transition-all duration-200 {active
							? 'bg-[var(--color-brand)]/10 text-[var(--color-ink-950)]'
							: 'text-[var(--color-ink-700)] hover:bg-[var(--color-ink-100)] hover:text-[var(--color-ink-900)]'}"
					>
						{#if active}
							<div class="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-[var(--color-brand)]"></div>
						{/if}
						<Icon class="h-4 w-4 {active ? 'text-[var(--color-brand)]' : ''}" />
						<span class="flex-1">{item.label}</span>
						<span class="font-mono text-[10px] text-[var(--color-ink-500)]">{item.kbd}</span>
					</a>
				</li>
			{/each}
		</ul>
	</nav>

	<div class="flex items-center gap-3 border-t border-[var(--color-ink-300)] px-6 py-5">
		<img src={twakeLogo} alt="Twake" class="h-6 w-6" />
		<img src={linagoraLogo} alt="Linagora" class="logo-adapt h-5 w-auto opacity-80" />
	</div>
</aside>
