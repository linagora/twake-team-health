import { env } from '$env/dynamic/private';
import type { Repo, RepoMonth } from './github/types';

const keyOf = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/** Repos whose GitHub releases are excluded from the stats org-wide, from env
 * NO_RELEASE_REPOS (comma-separated "owner/repo"). Case-insensitive. This applies
 * everywhere, including views built from GLOBAL_REPOS that carry no per-team flag. */
export function globalNoReleaseRepos(): Set<string> {
	return new Set(
		(env.NO_RELEASE_REPOS ?? '')
			.split(',')
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s.includes('/'))
	);
}

/** Zero the release count for repo-months whose repo is excluded, either by the
 * selection's per-repo `noReleases` flag or the global ignore list. Pure: returns
 * a new array, leaving the stored GitHub counts untouched (excluded at read time). */
export function excludeReleases(rows: RepoMonth[], repos: Repo[], globalSet: Set<string>): RepoMonth[] {
	const ignored = new Set([...globalSet].map((s) => s.toLowerCase()));
	for (const r of repos) if (r.noReleases) ignored.add(keyOf(r.owner, r.repo));
	if (!ignored.size) return rows;
	return rows.map((row) => (ignored.has(keyOf(row.owner, row.repo)) ? { ...row, releases: 0 } : row));
}
