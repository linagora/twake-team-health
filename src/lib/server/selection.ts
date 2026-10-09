import type { Repo, Selection } from './github/types';
import { parseMembers, parseRepos } from './validate';
import { allowedOrgs } from './discovery';
import { isMonthKey } from '$lib/months';

// Matches the cap a saved team accepts, so a saved team always reports in full.
const MAX_REPOS = 100;
const MAX_MEMBERS = 60;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
// Coerce to a finite number, else the default (a non-numeric `months` must not
// become NaN and flow into lastNMonths, which would yield an empty report).
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Throw rather than truncate: a silently dropped tail looks like missing activity.
function selectedRepos(value: unknown): Repo[] {
	const repos = parseRepos(value, Infinity, allowedOrgs());
	if (repos.length > MAX_REPOS) {
		throw new Error(`a selection is limited to ${MAX_REPOS} repositories (got ${repos.length})`);
	}
	return repos;
}

/** Validate and normalize an untrusted selection payload. Repos are sanitized
 * against GitHub identifier rules (injection guard) and restricted to the
 * allowed orgs (authorization guard, so the privileged token can't be pointed at
 * arbitrary repositories). Throws on a payload with no valid in-scope repos. */
export function parseSelection(body: unknown): Selection {
	const b = (body ?? {}) as Record<string, unknown>;
	const repos = selectedRepos(b.repos);
	const members = parseMembers(b.members, MAX_MEMBERS);

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
export function parseRepoSelection(body: unknown): Repo[] {
	const b = (body ?? {}) as Record<string, unknown>;
	const repos = selectedRepos(b.repos);
	if (repos.length === 0) {
		throw new Error('at least one repository in an allowed organization is required');
	}
	return repos;
}
