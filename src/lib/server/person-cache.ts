import { createCache } from './cache';
import { getPersonReport } from './person';
import type { PersonResult, Selection } from './github/types';
import { env } from '$env/dynamic/private';

const TTL_MS = Number(env.PERSON_CACHE_TTL_MS ?? 20 * 60 * 1000);

function personKey(s: Selection, login: string): string {
	return JSON.stringify({
		v: 1, // bump when PersonResult's shape or its derivation changes
		login: login.toLowerCase(),
		repos: s.repos.map((r) => `${r.owner}/${r.repo}`).sort(),
		// The whole roster is part of the key, not just the subject: attribution is
		// roster-wide (a shared email, a peer joining or leaving) so another
		// member's email change can alter this member's numbers.
		members: s.members.map((m) => `${m.login}:${m.email ?? ''}`).sort(),
		months: s.months,
		memberMonths: s.memberMonths,
		to: s.to ?? null,
	});
}

const cache = createCache<PersonResult>('person', TTL_MS);

/** Cached, concurrency-de-duplicated per-member report. */
export function getPerson(selection: Selection, login: string): Promise<PersonResult> {
	return cache.getOrCompute(personKey(selection, login), () =>
		getPersonReport(selection, login),
	);
}

/** Recompute NOW and replace the cached entry (user-triggered refresh). */
export async function refreshPerson(selection: Selection, login: string): Promise<PersonResult> {
	const result = await getPersonReport(selection, login);
	await cache.set(personKey(selection, login), result);
	return result;
}
