import { browser } from '$app/environment';
import type { MetricsResult } from '$lib/server/github/types';
import type { PageLoad } from './$types';

// Server-render the first paint with the built-in default selection's metrics so
// the dashboard shows numbers instead of a spinner on initial load. On client-side
// navigation the metrics store already holds the team-scoped data, so skip the
// round-trip there and let the store drive.
export const load: PageLoad = async ({ fetch }) => {
	if (browser) return { initial: null as MetricsResult | null };
	try {
		const res = await fetch('/api/metrics');
		return { initial: res.ok ? ((await res.json()) as MetricsResult) : null };
	} catch {
		return { initial: null as MetricsResult | null };
	}
};
