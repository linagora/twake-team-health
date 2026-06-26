// Client-side metrics loader. Posts the active selection to /api/metrics and
// exposes reactive { loading, error, data } via Svelte 5 runes.
import type { MetricsResult, Selection } from '$lib/server/github/types';
import type { Team } from './selection';

export function selectionFor(team: Team, months: number, memberMonths: number): Selection {
	return { repos: team.repos, members: team.members, months, memberMonths };
}

/** Session expired: bounce to sign-in so the user re-authenticates instead of
 * seeing a parse error from an HTML redirect body. */
export function redirectToSignIn(): void {
	if (typeof window !== 'undefined') {
		window.location.href = `/auth/signin?callbackUrl=${encodeURIComponent(location.pathname)}`;
	}
}

class MetricsStore {
	loading = $state(false);
	error = $state<string | null>(null);
	data = $state<MetricsResult | null>(null);
	#seq = 0;
	#last: Selection | null = null;

	/** Re-run the most recent load (used by the route-aware Refresh button). */
	reload(): void {
		if (this.#last) this.load(this.#last);
	}

	async load(selection: Selection): Promise<void> {
		this.#last = selection;
		const seq = ++this.#seq;
		this.loading = true;
		this.error = null;
		try {
			const res = await fetch('/api/metrics', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(selection)
			});
			if (seq !== this.#seq) return; // a newer request superseded this one
			if (res.status === 401) return redirectToSignIn();
			if (!res.ok) {
				this.error = `${res.status}: ${(await res.text()).slice(0, 200)}`;
				return;
			}
			this.data = (await res.json()) as MetricsResult;
		} catch (e) {
			if (seq === this.#seq) this.error = (e as Error).message;
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}
}

// Team-scoped report (driven by the Scope bar) and the independent org-wide
// Global report each get their own store.
export const metrics = new MetricsStore();
export const globalMetrics = new MetricsStore();
