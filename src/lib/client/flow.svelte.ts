// Client-side loader for cycle-time + review-health. Posts the active team's
// repos + window to /api/flow.
import type { FlowResult, Repo } from '$lib/server/github/types';
import { repoKey } from './selection';
import { Resource, postJson } from './resource.svelte';

class FlowStore extends Resource<FlowResult> {
	#req(repos: Repo[], months: number, to?: string) {
		return {
			key: JSON.stringify({ r: repos.map(repoKey).sort(), months, to }),
			fetcher: () => postJson('/api/flow', { repos, months, ...(to ? { to } : {}) })
		};
	}

	load(repos: Repo[], months: number, to?: string): Promise<void> {
		const { key, fetcher } = this.#req(repos, months, to);
		return this.run(key, fetcher);
	}

	ensure(repos: Repo[], months: number, to?: string): void {
		const { key, fetcher } = this.#req(repos, months, to);
		this.ensureKey(key, fetcher);
	}
}

export const flow = new FlowStore();
