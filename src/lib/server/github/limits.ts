import { env } from '$env/dynamic/private';

// The GraphQL semaphore cap, kept in its own tiny module (no heavy imports) so
// the low-level client and the settings layer can share it without an import
// cycle (client <- discovery <- app-config). Admin settings update it at runtime.
let maxConcurrency = Number(env.GITHUB_MAX_CONCURRENCY) || 8;

export const getMaxConcurrency = (): number => maxConcurrency;

export function setMaxConcurrency(n: number): void {
	if (Number.isFinite(n) && n >= 1) maxConcurrency = Math.min(Math.floor(n), 32);
}
