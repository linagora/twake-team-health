import { describe, it, expect } from 'vitest';
import { excludeReleases } from './release-exclusions';
import type { Repo, RepoMonth } from './github/types';

function row(owner: string, repo: string, releases: number): RepoMonth {
	return {
		owner,
		repo,
		month: '2026-06',
		created: 0,
		merged: 0,
		closed: 0,
		additions: 0,
		deletions: 0,
		addPerPr: 0,
		delPerPr: 0,
		daysPerPr: 0,
		commentsPerPr: 0,
		reviewsPerPr: 0,
		bugs: 0,
		issues: 0,
		issuesOpen: 0,
		bugsOpen: 0,
		prsOpen: 0,
		releases,
		resolutionDays: 0,
		resolutionRate: 0
	};
}

const rows = [row('linagora', 'cozy-libs', 854), row('linagora', 'twake-drive', 29)];

describe('excludeReleases', () => {
	it('returns rows unchanged when nothing is excluded', () => {
		const repos: Repo[] = [{ owner: 'linagora', repo: 'cozy-libs' }];
		expect(excludeReleases(rows, repos, new Set())).toBe(rows);
	});

	it("zeroes releases for a selection repo flagged noReleases, leaving others", () => {
		const repos: Repo[] = [
			{ owner: 'linagora', repo: 'cozy-libs', noReleases: true },
			{ owner: 'linagora', repo: 'twake-drive' }
		];
		const out = excludeReleases(rows, repos, new Set());
		expect(out.find((r) => r.repo === 'cozy-libs')!.releases).toBe(0);
		expect(out.find((r) => r.repo === 'twake-drive')!.releases).toBe(29);
	});

	it('zeroes releases for repos in the global ignore list (case-insensitive)', () => {
		const repos: Repo[] = [{ owner: 'linagora', repo: 'cozy-libs' }];
		const out = excludeReleases(rows, repos, new Set(['LINAGORA/COZY-LIBS']));
		expect(out.find((r) => r.repo === 'cozy-libs')!.releases).toBe(0);
		expect(out.find((r) => r.repo === 'twake-drive')!.releases).toBe(29);
	});

	it('does not mutate the input rows', () => {
		const repos: Repo[] = [{ owner: 'linagora', repo: 'cozy-libs', noReleases: true }];
		excludeReleases(rows, repos, new Set());
		expect(rows[0].releases).toBe(854);
	});
});
