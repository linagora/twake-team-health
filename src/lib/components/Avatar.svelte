<script lang="ts">
	// GitHub avatar by login. The login-based URL needs no API call (so no rate
	// limit), and falls back to initials for deleted accounts or bots without one.
	let {
		login,
		name = '',
		size = 20,
		srcUrl = '',
		class: klass = ''
	}: { login: string; name?: string; size?: number; srcUrl?: string; class?: string } = $props();

	let failed = $state(false);
	const initials = $derived(
		(
			(name || login)
				.trim()
				.split(/\s+/)
				.map((w) => w[0])
				.join('')
				.slice(0, 2) || '?'
		).toUpperCase()
	);
	// Explicit URL wins (e.g. a GitHub App's avatar, which has no login `.png`);
	// otherwise derive it from the login.
	const src = $derived(srcUrl || `https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`);
</script>

{#if failed}
	<span
		class="inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--color-ink-200)] font-mono leading-none text-[var(--color-ink-600)] {klass}"
		style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.4)}px"
		aria-hidden="true">{initials}</span
	>
{:else}
	<!-- Decorative: the member's name is always shown alongside, so keep alt empty. -->
	<img
		{src}
		alt=""
		width={size}
		height={size}
		loading="lazy"
		class="shrink-0 rounded-full bg-[var(--color-ink-100)] object-cover {klass}"
		onerror={() => (failed = true)}
	/>
{/if}
