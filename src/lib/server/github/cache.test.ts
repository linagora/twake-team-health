import { describe, it, expect } from 'vitest';
import { TTLCache } from './cache';

describe('TTLCache.getOrCompute (single-flight)', () => {
	it('coalesces concurrent identical calls into one compute', async () => {
		const cache = new TTLCache<number>(10_000);
		let calls = 0;
		const compute = () =>
			new Promise<number>((resolve) => {
				calls++;
				setTimeout(() => resolve(42), 10);
			});

		const results = await Promise.all([
			cache.getOrCompute('k', compute),
			cache.getOrCompute('k', compute),
			cache.getOrCompute('k', compute)
		]);

		expect(calls).toBe(1); // three concurrent callers, one fetch
		expect(results).toEqual([42, 42, 42]);
	});

	it('serves a cached value without recomputing', async () => {
		const cache = new TTLCache<number>(10_000);
		let calls = 0;
		const compute = async () => {
			calls++;
			return 7;
		};
		await cache.getOrCompute('k', compute);
		await cache.getOrCompute('k', compute);
		expect(calls).toBe(1);
	});

	it('does not cache a rejected compute, so the next call retries', async () => {
		const cache = new TTLCache<number>(10_000);
		let calls = 0;
		const compute = async () => {
			calls++;
			if (calls === 1) throw new Error('boom'); // e.g. a transient rate limit
			return 5;
		};
		await expect(cache.getOrCompute('k', compute)).rejects.toThrow('boom');
		await expect(cache.getOrCompute('k', compute)).resolves.toBe(5);
		expect(calls).toBe(2);
	});
});
