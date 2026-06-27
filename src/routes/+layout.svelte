<script lang="ts">
	import '../app.css';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import ScopeBar from '$lib/components/ScopeBar.svelte';
	import LoadingBar from '$lib/components/LoadingBar.svelte';
	import { scope } from '$lib/client/scope.svelte';
	import { metrics, globalMetrics } from '$lib/client/metrics.svelte';
	import { attention } from '$lib/client/attention.svelte';
	import { flow } from '$lib/client/flow.svelte';
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';

	let { children, data } = $props();

	// The store that backs the current route, so the loading dim, the top bar, and
	// Refresh all act on the data actually shown (not always the team report).
	const active = $derived.by(() => {
		const p = page.url.pathname;
		if (p.startsWith('/attention')) return { loading: attention.loading, refresh: () => attention.reload() };
		if (p.startsWith('/flow')) return { loading: flow.loading, refresh: () => flow.reload() };
		if (p.startsWith('/global') || p.startsWith('/breakdown')) return { loading: globalMetrics.loading, refresh: () => globalMetrics.reload() };
		return { loading: metrics.loading, refresh: () => scope.reload() };
	});
	const loading = $derived(active.loading);

	// Per-page browser title: "Section · team·health".
	const pageSection = $derived.by(() => {
		const p = page.url.pathname;
		if (p === '/') return 'Overview';
		if (p.startsWith('/signals')) return 'Signals';
		if (p.startsWith('/attention')) return 'Attention';
		if (p.startsWith('/flow')) return 'Flow';
		if (p.startsWith('/global')) return 'Global trends';
		if (p.startsWith('/breakdown')) return 'Breakdown';
		if (p.startsWith('/teams')) return 'Teams';
		if (p.startsWith('/bots')) return 'Bots';
		if (p.startsWith('/logs')) return 'Logs';
		if (p.startsWith('/settings')) return 'Settings';
		if (p.startsWith('/charts')) return 'Charts';
		if (p.startsWith('/auth')) return 'Sign in';
		return '';
	});
	const pageTitle = $derived(pageSection ? `${pageSection} · team·health` : 'team·health');

	// Mobile nav drawer (sidebar collapses below lg).
	let drawerOpen = $state(false);
	// Close the drawer on navigation.
	$effect(() => {
		void page.url.pathname;
		drawerOpen = false;
	});

	// Seed the scope from server configuration (the configurable default teams),
	// then let it manage selection + metrics loading client-side. A URL query string
	// (shared/bookmarked link) takes precedence over the per-browser preference.
	$effect(() => {
		if (!scope.initialized) {
			scope.months = data.defaults.months;
			scope.memberMonths = data.defaults.memberMonths;
			scope.init(data.defaultTeams, data.teamsPersisted, page.url);
		}
	});

	// Keep the scope in the URL after every navigation, so each page is a shareable
	// link. Plain sidebar links carry no query string; this re-applies it. Runs after
	// the router is initialized, so replaceState is safe here (unlike a mount effect).
	afterNavigate(() => scope.syncUrl());
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta property="og:site_name" content="Twake" />
	<meta property="og:type" content="website" />
	<meta property="og:title" content="team·health · engineering metrics" />
	<meta property="og:description" content="Live engineering-delivery metrics for any GitHub team: PR throughput, review depth, code volume, and release cadence." />
	<meta property="og:url" content={page.url.href} />
	<meta property="og:image" content="{page.url.origin}/og.png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="team·health · engineering metrics" />
	<meta name="twitter:description" content="Live engineering-delivery metrics for any GitHub team." />
	<meta name="twitter:image" content="{page.url.origin}/og.png" />
</svelte:head>

<div class="flex min-h-screen">
	{#if drawerOpen}
		<button
			class="fixed inset-0 z-40 bg-[var(--color-ink-950)]/30 backdrop-blur-sm lg:hidden"
			aria-label="Close menu"
			onclick={() => (drawerOpen = false)}
		></button>
	{/if}

	<Sidebar open={drawerOpen} onClose={() => (drawerOpen = false)} isAdmin={data.isAdmin} orgName={data.orgName} />

	<main class="flex-1 min-w-0">
		<ScopeBar
			user={data.user}
			authEnabled={data.authEnabled}
			busy={loading}
			onRefresh={active.refresh}
			onMenu={() => (drawerOpen = true)}
		/>
		<LoadingBar active={loading} />
		<!-- Dim + soften the stale view while a new report loads, so it's clearly refreshing. -->
		<div class="transition-opacity duration-200 {loading ? 'pointer-events-none opacity-45' : ''}" aria-busy={loading}>
			{@render children()}
		</div>
	</main>
</div>
