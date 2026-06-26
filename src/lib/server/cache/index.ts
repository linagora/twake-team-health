// Cache abstraction: in-memory by default, Redis when REDIS_URL is set. The
// interface is identical so consumers don't care which backend is live. Redis is
// what makes the app correct behind a load balancer with multiple replicas: a
// shared result/discovery cache + cross-replica single-flight means concurrent
// identical report requests collapse to ONE GitHub fetch instead of one each.
import { env } from '$env/dynamic/private';
import { TTLCache } from '../github/cache';
import { getRedis } from './redis';

export interface Cache<V> {
	get(key: string): Promise<V | undefined>;
	set(key: string, value: V): Promise<void>;
	/** Cached value, or compute it once even across concurrent callers/replicas. */
	getOrCompute(key: string, compute: () => Promise<V>): Promise<V>;
}

// ----- in-memory backend (single replica / dev) -----
class MemoryCache<V> implements Cache<V> {
	#inner: TTLCache<V>;
	constructor(ttlMs: number) {
		this.#inner = new TTLCache<V>(ttlMs);
	}
	async get(key: string) {
		return this.#inner.get(key);
	}
	async set(key: string, value: V) {
		this.#inner.set(key, value);
	}
	getOrCompute(key: string, compute: () => Promise<V>) {
		return this.#inner.getOrCompute(key, compute);
	}
}

// ----- Redis backend (multi-replica) -----
// Must exceed the worst-case report build (a large team's first fetch over many
// repos can take minutes). If the lock expires mid-compute, concurrent requests
// for the same selection stampede and each re-runs the expensive fetch.
const LOCK_TTL_MS = Number(env.CACHE_LOCK_TTL_MS ?? 600_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RedisCache<V> implements Cache<V> {
	// Same-process in-flight de-dup: the Redis lock collapses work across replicas,
	// but N concurrent callers in THIS process should share one promise rather than
	// each poll Redis independently.
	#inflight = new Map<string, Promise<V>>();

	constructor(
		private readonly prefix: string,
		private readonly ttlMs: number
	) {}

	#key(key: string) {
		return `th:${this.prefix}:${key}`;
	}
	#lock(key: string) {
		return `th:${this.prefix}:lock:${key}`;
	}

	async get(key: string): Promise<V | undefined> {
		try {
			const raw = await getRedis().get(this.#key(key));
			return raw ? (JSON.parse(raw) as V) : undefined;
		} catch {
			return undefined; // Redis hiccup → treat as a miss, never crash a request
		}
	}

	async set(key: string, value: V): Promise<void> {
		try {
			await getRedis().set(this.#key(key), JSON.stringify(value), 'PX', this.ttlMs);
		} catch {
			/* best-effort cache write */
		}
	}

	async getOrCompute(key: string, compute: () => Promise<V>): Promise<V> {
		const cached = await this.get(key);
		if (cached !== undefined) return cached;

		const pending = this.#inflight.get(key);
		if (pending) return pending;

		const promise = this.#computeWithLock(key, compute).finally(() => this.#inflight.delete(key));
		this.#inflight.set(key, promise);
		return promise;
	}

	async #computeWithLock(key: string, compute: () => Promise<V>): Promise<V> {
		const redis = getRedis();
		const lockKey = this.#lock(key);
		// Unique token so we only release a lock we still own (fencing): if compute
		// outran LOCK_TTL_MS and another replica re-acquired, we must not delete theirs.
		const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		let acquired = false;
		try {
			acquired = (await redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
		} catch {
			acquired = true; // Redis lock unavailable → just compute
		}

		if (acquired) {
			try {
				const value = await compute();
				await this.set(key, value);
				return value;
			} finally {
				try {
					// Compare-and-delete: release only if the token is still ours.
					await redis.eval(
						"if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
						1,
						lockKey,
						token
					);
				} catch {
					/* lock will expire on its own */
				}
			}
		}

		// Another replica is computing it: wait for the result to appear.
		const deadline = Date.now() + LOCK_TTL_MS;
		while (Date.now() < deadline) {
			await sleep(400);
			const v = await this.get(key);
			if (v !== undefined) return v;
			try {
				if (!(await redis.exists(lockKey))) break; // holder gave up
			} catch {
				break;
			}
		}
		// Fell through (timeout / lock gone): compute ourselves.
		const value = await compute();
		await this.set(key, value);
		return value;
	}
}

export function createCache<V>(name: string, ttlMs: number): Cache<V> {
	// Guard against a non-numeric env-derived TTL (NaN would make entries expire
	// immediately or never, depending on the backend's comparisons).
	const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 20 * 60 * 1000;
	return env.REDIS_URL ? new RedisCache<V>(name, ttl) : new MemoryCache<V>(ttl);
}

export const cacheBackend = env.REDIS_URL ? 'redis' : 'memory';
