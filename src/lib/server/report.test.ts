import { describe, it, expect } from 'vitest';
import { monthsToFetch } from './report';
import { monthKey, monthEndMs, type Month } from './github/months';

// June 2026 is the current (in-progress) month for these tests.
const NOW = Date.parse('2026-06-15T12:00:00Z');
const CURRENT: Month = { year: 2026, month: 6 };
const APRIL: Month = { year: 2026, month: 4 };
const MAY: Month = { year: 2026, month: 5 };
const currentKey = monthKey(CURRENT);
const TTL = 6 * 60 * 60 * 1000;

const months = [APRIL, MAY, CURRENT];
// One repo per month is the required key in these tests.
const required = (m: Month) => [`o/r::${monthKey(m)}`];
const keyOf = (m: Month) => `o/r::${monthKey(m)}`;

describe('monthsToFetch', () => {
	it('fetches every month when nothing is stored', () => {
		const stale = monthsToFetch(months, required, new Map(), currentKey, NOW);
		expect(stale).toEqual([APRIL, MAY, CURRENT]);
	});

	it('fetches nothing when completed months are finalized and the current month is fresh', () => {
		const fetchedAt = new Map<string, Date>([
			// completed months fetched after they ended → frozen
			[keyOf(APRIL), new Date(monthEndMs(APRIL) + 1000)],
			[keyOf(MAY), new Date(monthEndMs(MAY) + 1000)],
			// current month fetched 1h ago → within TTL
			[keyOf(CURRENT), new Date(NOW - 60 * 60 * 1000)]
		]);
		expect(monthsToFetch(months, required, fetchedAt, currentKey, NOW)).toEqual([]);
	});

	it('refetches only the current month once it is older than the TTL', () => {
		const fetchedAt = new Map<string, Date>([
			[keyOf(APRIL), new Date(monthEndMs(APRIL) + 1000)],
			[keyOf(MAY), new Date(monthEndMs(MAY) + 1000)],
			[keyOf(CURRENT), new Date(NOW - TTL - 1000)] // stale
		]);
		expect(monthsToFetch(months, required, fetchedAt, currentKey, NOW)).toEqual([CURRENT]);
	});

	it('refetches a completed month that was only ever stored while in progress', () => {
		// MAY was fetched on May 10 (before it ended) → not yet final, must refetch once.
		const fetchedAt = new Map<string, Date>([
			[keyOf(APRIL), new Date(monthEndMs(APRIL) + 1000)],
			[keyOf(MAY), new Date(Date.parse('2026-05-10T00:00:00Z'))],
			[keyOf(CURRENT), new Date(NOW - 1000)]
		]);
		expect(monthsToFetch(months, required, fetchedAt, currentKey, NOW)).toEqual([MAY]);
	});

	it('refetches a month if any one required key is missing (e.g. a newly added repo)', () => {
		const twoRepos = (m: Month) => [`o/r::${monthKey(m)}`, `o/new::${monthKey(m)}`];
		const fetchedAt = new Map<string, Date>([
			['o/r::' + monthKey(MAY), new Date(monthEndMs(MAY) + 1000)]
			// o/new::2026-05 absent
		]);
		expect(monthsToFetch([MAY], twoRepos, fetchedAt, currentKey, NOW)).toEqual([MAY]);
	});

	it('refetches a month where one repo is fresh but another is stale by time', () => {
		const twoRepos = (m: Month) => [`o/a::${monthKey(m)}`, `o/b::${monthKey(m)}`];
		const fetchedAt = new Map<string, Date>([
			[`o/a::${monthKey(CURRENT)}`, new Date(NOW - 60 * 60 * 1000)], // fresh
			[`o/b::${monthKey(CURRENT)}`, new Date(NOW - TTL - 1000)] // stale
		]);
		expect(monthsToFetch([CURRENT], twoRepos, fetchedAt, currentKey, NOW)).toEqual([CURRENT]);
	});

	it('handles member-grid keys (login::owner/repo::month) the same way', () => {
		const members = ['alice', 'bob'];
		const repos = ['o/r'];
		const memberKeys = (m: Month) =>
			members.flatMap((login) => repos.map((r) => `${login}::${r}::${monthKey(m)}`));
		const fresh = new Map<string, Date>(
			memberKeys(CURRENT).map((k) => [k, new Date(NOW - 60 * 60 * 1000)])
		);
		expect(monthsToFetch([CURRENT], memberKeys, fresh, currentKey, NOW)).toEqual([]);

		// Drop bob's row → the month must be refetched.
		const partial = new Map(fresh);
		partial.delete(`bob::o/r::${monthKey(CURRENT)}`);
		expect(monthsToFetch([CURRENT], memberKeys, partial, currentKey, NOW)).toEqual([CURRENT]);
	});
});
