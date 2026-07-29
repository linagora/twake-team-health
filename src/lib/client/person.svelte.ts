// Per-member report for the profile page. Posts the same Selection the metrics
// store posts, plus the member to report on, so both views resolve the identical
// window and roster.
import type { PersonResult, Selection } from '$lib/server/github/types';
import { Resource, postJson } from './resource.svelte';

class PersonStore extends Resource<PersonResult> {
	#req(selection: Selection, login: string) {
		return {
			key: JSON.stringify({ s: selection, login: login.toLowerCase() }),
			fetcher: () => postJson('/api/person', { ...selection, login })
		};
	}

	load(selection: Selection, login: string): Promise<void> {
		const { key, fetcher } = this.#req(selection, login);
		return this.run(key, fetcher);
	}

	ensure(selection: Selection, login: string): void {
		const { key, fetcher } = this.#req(selection, login);
		this.ensureKey(key, fetcher);
	}
}

export const person = new PersonStore();
