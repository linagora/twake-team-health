import type { Repo, Selection } from './github/types';
import { limitedMembers, limitedRepos, type ListLimits } from './validate';
import { allowedOrgs } from './discovery';
import { isMonthKey } from '$lib/months';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
// Coerce to a finite number, else the default (a non-numeric `months` must not
// become NaN and flow into lastNMonths, which would yield an empty report).
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Validate and normalize an untrusted selection payload. Repos are sanitized
 * against GitHub identifier rules (injection guard) and restricted to the
 * allowed orgs (authorization guard, so the privileged token can't be pointed at
 * arbitrary repositories). Throws on a payload with no valid in-scope repos, or
 * one over the configured limits. */
export function parseSelection(body: unknown, limits: ListLimits): Selection {
	const b = (body ?? {}) as Record<string, unknown>;
	const repos = limitedRepos(b.repos, limits.maxRepos, allowedOrgs());
	const members = limitedMembers(b.members, limits.maxMembers);

	if (repos.length === 0) {
		throw new Error('selection must include at least one repository in an allowed organization');
	}

	const to = isMonthKey(b.to) ? b.to : undefined;

	return {
		repos,
		members,
		months: clamp(num(b.months, 12), 1, 24),
		memberMonths: clamp(num(b.memberMonths, 3), 1, 12),
		...(to ? { to } : {})
	};
}

/** Validate just a repo list (same injection + allowed-org guards as selection). */
export function parseRepoSelection(body: unknown, maxRepos: number): Repo[] {
	const b = (body ?? {}) as Record<string, unknown>;
	const repos = limitedRepos(b.repos, maxRepos, allowedOrgs());
	if (repos.length === 0) {
		throw new Error('at least one repository in an allowed organization is required');
	}
	return repos;
}
