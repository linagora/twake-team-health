// Client-side loader for the open-PR worklist. Posts the active team's repos to
// /api/attention and exposes reactive { loading, error, data }.
import type { AttentionResult, Repo } from '$lib/server/github/types';
import { redirectToSignIn } from './metrics.svelte';

class AttentionStore {
	loading = $state(false);
	error = $state<string | null>(null);
	data = $state<AttentionResult | null>(null);
	#seq = 0;
	#key = '';
	#last: Repo[] | null = null;

	reload(): void {
		if (this.#last) this.load(this.#last);
	}

	async load(repos: Repo[]): Promise<void> {
		this.#last = repos;
		const key = repos.map((r) => `${r.owner}/${r.repo}`).sort().join(',');
		this.#key = key;
		const seq = ++this.#seq;
		this.loading = true;
		this.error = null;
		try {
			const res = await fetch('/api/attention', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repos })
			});
			if (seq !== this.#seq) return;
			if (res.status === 401) return redirectToSignIn();
			if (!res.ok) {
				this.error = `${res.status}: ${(await res.text()).slice(0, 200)}`;
				return;
			}
			this.data = (await res.json()) as AttentionResult;
		} catch (e) {
			if (seq === this.#seq) this.error = (e as Error).message;
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}

	/** Load only if the repo set changed since the last load. */
	ensure(repos: Repo[]): void {
		const key = repos.map((r) => `${r.owner}/${r.repo}`).sort().join(',');
		if (key !== this.#key || (!this.data && !this.loading)) this.load(repos);
	}
}

export const attention = new AttentionStore();
