import { env } from '$env/dynamic/private';
import { getMaxConcurrency } from './limits';

const ENDPOINT = 'https://api.github.com/graphql';
const RETRY_DELAYS_MS = [0, 1000, 3000, 8000];
// How long to pause ALL calls after a secondary (abuse) rate limit, when GitHub
// doesn't send a Retry-After. Coordinated so a burst self-throttles instead of
// every call retrying into the same wall.
const SECONDARY_COOLDOWN_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Circuit breaker for the primary GitHub rate limit. Once the shared token's
// hourly quota is spent, every further call would fail the same way until the
// reset, so we record the reset time and fail fast (no network, no semaphore)
// instead of piling more failing requests onto the exhausted token.
let rateLimitedUntil = 0;

function rateLimitResetMs(res: Response): number {
	const reset = Number(res.headers.get('x-ratelimit-reset'));
	// Header is epoch seconds; fall back to a short cooldown if it's missing.
	return Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60_000;
}

// A tiny semaphore so the shared read-only token is never hammered with more
// than the configured cap of in-flight GraphQL calls, even under concurrent users.
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
	if (active < getMaxConcurrency()) {
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

/** The shared token's primary rate limit is exhausted. `resetAt` is epoch ms. */
export class RateLimitError extends GitHubError {
	constructor(public readonly resetAt: number) {
		super(`GitHub API rate limit exceeded. Resets at ${new Date(resetAt).toISOString()}.`);
		this.name = 'RateLimitError';
	}
}

export type GraphQL = (query: string) => Promise<Record<string, unknown>>;

/** Run a GraphQL query against GitHub with the read-only token, retrying transient
 * failures. Returns the `data` object. Throws GitHubError on GraphQL errors or
 * exhausted retries. */
export const graphql: GraphQL = async (query) => {
	const token = env.GITHUB_TOKEN;
	if (!token) throw new GitHubError('GITHUB_TOKEN is not set');

	// Fail fast while the breaker is open, before taking a semaphore slot.
	if (rateLimitedUntil > Date.now()) throw new RateLimitError(rateLimitedUntil);

	await acquire();
	try {
		// Re-check after acquiring: the breaker may have opened while we waited for a
		// slot, so queued calls don't all fire into an open limit and prolong it.
		if (rateLimitedUntil > Date.now()) throw new RateLimitError(rateLimitedUntil);
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
				// Secondary / abuse limit: open a short shared cooldown so every call
				// backs off together (retrying into it just sustains the limit), and
				// honor GitHub's Retry-After when present.
				if (/abuse|secondary/i.test(body)) {
					const retryAfter = Number(res.headers.get('retry-after'));
					const cooldown = retryAfter > 0 ? retryAfter * 1000 : SECONDARY_COOLDOWN_MS;
					rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + cooldown);
					throw new RateLimitError(rateLimitedUntil);
				}
				// Primary limit: the hourly quota is spent. Open the breaker and fail
				// fast (retrying within seconds is useless when it resets hourly).
				if (/api rate limit exceeded/i.test(body)) {
					rateLimitedUntil = rateLimitResetMs(res);
					throw new RateLimitError(rateLimitedUntil);
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
				// Primary limit can come back as a 200 with a RATE_LIMIT error type.
				if (/RATE_LIMIT/.test(msg)) {
					rateLimitedUntil = rateLimitResetMs(res);
					throw new RateLimitError(rateLimitedUntil);
				}
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
