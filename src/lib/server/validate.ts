import type { Member, Repo } from './github/types';

// GitHub identifiers, used to reject anything that could break out of a GraphQL
// string literal (injection) before interpolation, and to bound list sizes.
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/; // org/user/member login
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const EMAIL_RE = /^[^\s"<>\\]{1,254}$/;

const isLogin = (s: unknown): s is string => typeof s === 'string' && LOGIN_RE.test(s);
const isRepoName = (s: unknown): s is string => typeof s === 'string' && REPO_RE.test(s);

/** Parse + sanitize an untrusted members array. Drops malformed entries. */
export function parseMembers(value: unknown, cap: number): Member[] {
	if (!Array.isArray(value)) return [];
	const out: Member[] = [];
	for (const raw of value) {
		const m = raw as Record<string, unknown>;
		if (!m || !isLogin(m.login)) continue;
		const email = typeof m.email === 'string' && EMAIL_RE.test(m.email) ? m.email : undefined;
		out.push({
			login: m.login,
			name: typeof m.name === 'string' && m.name ? m.name : m.login,
			email
		});
		if (out.length >= cap) break;
	}
	return out;
}

/** Parse + sanitize an untrusted repos array. Drops anything not matching GitHub
 * identifier rules (this is the injection guard) and, when `allowed` is given,
 * anything outside the allowed orgs (the authorization guard). */
export function parseRepos(value: unknown, cap: number, allowed?: string[]): Repo[] {
	if (!Array.isArray(value)) return [];
	const allowSet = allowed ? new Set(allowed.map((o) => o.toLowerCase())) : null;
	const seen = new Set<string>();
	const out: Repo[] = [];
	for (const raw of value) {
		const r = raw as Record<string, unknown>;
		if (!r || !isLogin(r.owner) || !isRepoName(r.repo)) continue;
		if (allowSet && !allowSet.has((r.owner as string).toLowerCase())) continue;
		const key = `${r.owner}/${r.repo}`.toLowerCase(); // GitHub repos are case-insensitive
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ owner: r.owner, repo: r.repo, ...(r.noReleases === true ? { noReleases: true } : {}) });
		if (out.length >= cap) break;
	}
	return out;
}
