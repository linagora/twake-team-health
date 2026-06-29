<script lang="ts">
	import { signIn } from '@auth/sveltekit/client';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { theme } from '$lib/client/theme.svelte';
	import linagoraLogo from '$lib/assets/linagora-logo.svg';
	import twakeLogo from '$lib/assets/twake-logo.svg';
	import { LogIn, Loader2, Sun, Moon } from '@lucide/svelte';

	// Sync with the theme the boot script already applied, so the toggle reflects
	// (and persists) the user's choice even on this standalone page.
	onMount(() => theme.init());

	// orgName comes from the root layout load; callbackUrl/error from the query string
	// (Auth.js redirects back here with ?error= on a failed sign-in).
	const orgName = $derived((page.data.orgName as string) || 'Engineering metrics');
	const callbackUrl = $derived(page.url.searchParams.get('callbackUrl') || '/');
	// An error in the query (Auth.js redirect) or a thrown signIn (provider down /
	// misconfigured) both surface the same banner instead of failing silently.
	let signinFailed = $state(false);
	const showError = $derived(!!page.url.searchParams.get('error') || signinFailed);

	let busy = $state(false);
	async function login() {
		busy = true;
		signinFailed = false;
		try {
			await signIn('oidc', { callbackUrl });
		} catch {
			busy = false; // signIn navigates away on success; reset only if it threw
			signinFailed = true;
		}
	}
</script>

<svelte:head><title>Sign in · team·health</title></svelte:head>

<div class="relative flex min-h-screen flex-col items-center justify-center bg-[var(--color-ink-0)] px-6 py-12">
	<button
		onclick={() => theme.toggle()}
		class="absolute right-4 top-4 rounded-lg border border-[var(--color-ink-300)] bg-[var(--color-card)] p-2 text-[var(--color-ink-600)] transition-colors hover:text-[var(--color-ink-900)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--color-brand)]/40"
		aria-label="Toggle dark mode"
		title={theme.current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
	>
		{#if theme.current === 'dark'}<Sun class="h-4 w-4" />{:else}<Moon class="h-4 w-4" />{/if}
	</button>

	<div class="w-full max-w-sm">
		<!-- Brand mark + wordmark, echoing the sidebar header. -->
		<div class="mb-8 flex flex-col items-center text-center">
			<div class="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-brand)] shadow-sm">
				<svg viewBox="0 0 24 24" class="h-7 w-7" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M3 13h3l2 5 4-12 2 7h4" />
				</svg>
			</div>
			<div class="mt-4 font-display text-[2rem] leading-none tracking-tight text-[var(--color-ink-950)]">
				team<span class="text-[var(--color-brand)]">·</span>health
			</div>
			<div class="eyebrow mt-2 max-w-[220px] truncate">{orgName}</div>
		</div>

		<!-- Sign-in card. -->
		<div class="rounded-2xl border border-[var(--color-ink-300)] bg-[var(--color-card)] p-7 shadow-sm">
			<h1 class="font-display text-xl tracking-tight text-[var(--color-ink-950)]">Sign in</h1>
			<p class="mt-1.5 text-sm leading-relaxed text-[var(--color-ink-600)]">
				Use your organization account to access live engineering-delivery metrics.
			</p>

			{#if showError}
				<p class="mt-4 rounded-lg border border-[var(--color-negative)]/30 bg-[var(--color-negative)]/10 px-3 py-2 text-xs text-[var(--color-negative)]">
					Sign-in didn't complete. Please try again.
				</p>
			{/if}

			<button
				onclick={login}
				disabled={busy}
				class="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--color-brand-600)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--color-brand)]/40 disabled:opacity-60"
			>
				{#if busy}
					<Loader2 class="h-4 w-4 animate-spin" />
					Redirecting…
				{:else}
					<LogIn class="h-4 w-4" />
					Sign in with SSO
				{/if}
			</button>
		</div>

		<!-- Footer branding, mirroring the sidebar's logo treatment. -->
		<div class="mt-10 flex items-center justify-center gap-4">
			<img src={twakeLogo} alt="Twake" class="h-6 w-6" />
			<span class="h-4 w-px bg-[var(--color-ink-300)]"></span>
			<img src={linagoraLogo} alt="Linagora" class="logo-adapt h-5 w-auto opacity-80" />
		</div>
	</div>
</div>
