// Shared base for client data loaders: reactive { loading, error, data } over a
// POST endpoint, with a sequence guard (a newer request supersedes an older one),
// 401 -> sign-in, and keyed reload/ensure. The concrete stores just describe the
// request; all the fetch/state plumbing lives here.

/** Session expired: bounce to sign-in so the user re-authenticates instead of
 * seeing a parse error from an HTML redirect body. */
export function redirectToSignIn(): void {
	if (typeof window !== 'undefined') {
		window.location.href = `/auth/signin?callbackUrl=${encodeURIComponent(location.pathname)}`;
	}
}

export const postJson = (url: string, body: unknown): Promise<Response> =>
	fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});

export class Resource<T> {
	loading = $state(false);
	error = $state<string | null>(null);
	data = $state<T | null>(null);
	#seq = 0;
	#key = '';
	#fetcher: (() => Promise<Response>) | null = null;

	/** Run a request, remembering it for reload(). `key` identifies the request so
	 * ensure() can skip redundant loads. */
	protected run(key: string, fetcher: () => Promise<Response>): Promise<void> {
		this.#key = key;
		this.#fetcher = fetcher;
		return this.#exec(fetcher);
	}

	/** Load only if the request changed, or nothing has been loaded yet. */
	protected ensureKey(key: string, fetcher: () => Promise<Response>): void {
		if (key !== this.#key || (!this.data && !this.loading)) this.run(key, fetcher);
	}

	/** Re-run the most recent request (used by the route-aware Refresh button). */
	reload(): void {
		if (this.#fetcher) this.#exec(this.#fetcher);
	}

	async #exec(fetcher: () => Promise<Response>): Promise<void> {
		const seq = ++this.#seq;
		this.loading = true;
		this.error = null;
		try {
			const res = await fetcher();
			if (seq !== this.#seq) return; // a newer request superseded this one
			if (res.status === 401) return redirectToSignIn();
			if (!res.ok) {
				this.error = `${res.status}: ${(await res.text()).slice(0, 200)}`;
				return;
			}
			this.data = (await res.json()) as T;
		} catch (e) {
			if (seq === this.#seq) this.error = (e as Error).message;
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}
}
