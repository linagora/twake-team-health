// Client-side loader for the open-PR worklist. Posts the active team's repos to
// /api/attention and exposes reactive { loading, error, data }.
import type { AttentionResult, Repo } from '$lib/server/github/types';
import { repoKey } from './selection';
import { Resource, postJson } from './resource.svelte';

class AttentionStore extends Resource<AttentionResult> {
	#req(repos: Repo[]) {
		return {
			key: repos.map(repoKey).sort().join(','),
			fetcher: () => postJson('/api/attention', { repos })
		};
	}

	load(repos: Repo[]): Promise<void> {
		const { key, fetcher } = this.#req(repos);
		return this.run(key, fetcher);
	}

	/** Load only if the repo set changed since the last load. */
	ensure(repos: Repo[]): void {
		const { key, fetcher } = this.#req(repos);
		this.ensureKey(key, fetcher);
	}
}

export const attention = new AttentionStore();
