import { env } from '$env/dynamic/private';

const ENDPOINT = 'https://api.github.com/graphql';
const RETRY_DELAYS_MS = [0, 1000, 3000, 8000];
// Shared cap on in-flight GraphQL calls (protects the read-only token from
// secondary rate limits). `|| 8` guards against a non-numeric env value, which
// would otherwise be NaN and deadlock acquire().
const MAX_CONCURRENCY = Number(env.GITHUB_MAX_CONCURRENCY) || 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A tiny semaphore so the shared read-only token is never hammered with more
// than MAX_CONCURRENCY in-flight GraphQL calls, even under concurrent users.
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
	if (active < MAX_CONCURRENCY) {
		active++;
		return;
	}
	await new Promise<void>((resolve) => waiters.push(resolve));
	active++;
}
function release(): void {
	active--;
	waiters.shift()?.();
}

export class GitHubError extends Error {}

export type GraphQL = (query: string) => Promise<Record<string, unknown>>;

/** Run a GraphQL query against GitHub with the read-only token, retrying transient
 * failures. Returns the `data` object. Throws GitHubError on GraphQL errors or
 * exhausted retries. */
export const graphql: GraphQL = async (query) => {
	const token = env.GITHUB_TOKEN;
	if (!token) throw new GitHubError('GITHUB_TOKEN is not set');

	await acquire();
	try {
		let lastError = 'unknown error';
		for (const delay of RETRY_DELAYS_MS) {
			if (delay) await sleep(delay);
			let res: Response;
			try {
				res = await fetch(ENDPOINT, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
						'User-Agent': 'team-health'
					},
					body: JSON.stringify({ query })
				});
			} catch (e) {
				lastError = `network error: ${(e as Error).message}`;
				continue;
			}

			// 502/503/504 and secondary rate limits are transient; retry.
			if (res.status === 502 || res.status === 503 || res.status === 504) {
				await res.body?.cancel().catch(() => {}); // drain so the socket is freed
				lastError = `HTTP ${res.status}`;
				continue;
			}
			if (res.status === 401 || res.status === 403) {
				const body = await res.text();
				// Abuse / rate-limit responses are retryable; auth failures are not.
				if (/rate limit|abuse|secondary/i.test(body)) {
					lastError = `HTTP ${res.status}: rate limited`;
					continue;
				}
				throw new GitHubError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
			}
			if (!res.ok) {
				await res.body?.cancel().catch(() => {});
				lastError = `HTTP ${res.status}`;
				continue;
			}

			const body = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
			// A 200 with both data and errors is common (one inaccessible field/repo,
			// per-field rate limit). Keep the partial data unless it's a transient
			// resource-limit error and no data came back.
			if (body.errors?.length) {
				const msg = JSON.stringify(body.errors).slice(0, 300);
				if (!body.data && /resource limit|timeout/i.test(msg)) {
					lastError = `GraphQL: ${msg}`;
					continue;
				}
				if (!body.data) throw new GitHubError(`GraphQL error: ${msg}`);
			}
			if (!body.data) {
				lastError = 'empty response';
				continue;
			}
			return body.data;
		}
		throw new GitHubError(lastError);
	} finally {
		release();
	}
};
