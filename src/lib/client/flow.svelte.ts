// Client-side loader for cycle-time + review-health. Posts the active team's
// repos + window to /api/flow.
import type { FlowResult, Repo } from '$lib/server/github/types';
import { redirectToSignIn } from './metrics.svelte';

class FlowStore {
	loading = $state(false);
	error = $state<string | null>(null);
	data = $state<FlowResult | null>(null);
	#seq = 0;
	#key = '';
	#last: { repos: Repo[]; months: number } | null = null;

	reload(): void {
		if (this.#last) this.load(this.#last.repos, this.#last.months);
	}

	async load(repos: Repo[], months: number): Promise<void> {
		this.#last = { repos, months };
		const key = JSON.stringify({ r: repos.map((x) => `${x.owner}/${x.repo}`).sort(), months });
		this.#key = key;
		const seq = ++this.#seq;
		this.loading = true;
		this.error = null;
		try {
			const res = await fetch('/api/flow', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repos, months })
			});
			if (seq !== this.#seq) return;
			if (res.status === 401) return redirectToSignIn();
			if (!res.ok) {
				this.error = `${res.status}: ${(await res.text()).slice(0, 200)}`;
				return;
			}
			this.data = (await res.json()) as FlowResult;
		} catch (e) {
			if (seq === this.#seq) this.error = (e as Error).message;
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}

	ensure(repos: Repo[], months: number): void {
		const key = JSON.stringify({ r: repos.map((x) => `${x.owner}/${x.repo}`).sort(), months });
		if (key !== this.#key || (!this.data && !this.loading)) this.load(repos, months);
	}
}

export const flow = new FlowStore();
