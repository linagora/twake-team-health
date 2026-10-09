import type { Member, Repo } from './github/types';
import { limitedMembers, limitedRepos, type ListLimits } from './validate';
import { allowedOrgs } from './discovery';
import { isValidTimeZone } from '$lib/tz';

/** Validate/normalize an untrusted team payload. Repos are sanitized and restricted
 * to allowed orgs (shared with selection validation). The optional team `tz` is the
 * default timezone applied to members without their own. Throws on invalid input. */
export function parseTeamInput(
	body: unknown,
	limits: ListLimits
): { name: string; members: Member[]; repos: Repo[]; tz?: string } {
	const b = (body ?? {}) as Record<string, unknown>;
	const name = typeof b.name === 'string' ? b.name.trim().slice(0, 100) : '';
	const members = limitedMembers(b.members, limits.maxMembers);
	const repos = limitedRepos(b.repos, limits.maxRepos, allowedOrgs());
	const tz = isValidTimeZone(b.tz) ? b.tz : undefined;
	if (!name) throw new Error('team name is required');
	if (!repos.length) throw new Error('at least one repository in an allowed organization is required');
	return { name, members, repos, ...(tz ? { tz } : {}) };
}
