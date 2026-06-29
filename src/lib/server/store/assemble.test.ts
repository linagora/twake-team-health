import { describe, it, expect } from 'vitest';
import { assembleMetrics, type StoredRows } from './assemble';
import type { RepoMonth, Member } from '../github/types';

const repo = (over: Partial<RepoMonth>): RepoMonth => ({
	owner: 'linagora',
	repo: 'cozy-home',
	month: '2026-05',
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
	releases: 0,
	resolutionDays: 0,
	resolutionRate: 0,
	...over
});

const members: Member[] = [
	{ login: 'octocat', name: 'octocat' },
	{ login: 'hubot', name: 'hubot' }
];

const rows: StoredRows = {
	repoRows: [
		repo({ repo: 'cozy-home', month: '2026-05', issues: 4, bugs: 1 }),
		repo({ repo: 'cozy-admin', month: '2026-05', issues: 2, bugs: 1 })
	],
	memberRows: [
		{ login: 'octocat', owner: 'linagora', repo: 'cozy-home', month: '2026-05', commits: 10, weekendCommits: 3, lateNightCommits: 1, mergedPrs: 3, additions: 100, deletions: 20 },
		{ login: 'octocat', owner: 'linagora', repo: 'cozy-admin', month: '2026-05', commits: 4, weekendCommits: 1, lateNightCommits: 0, mergedPrs: 1, additions: 40, deletions: 10 },
		{ login: 'octocat', owner: 'linagora', repo: 'cozy-home', month: '2026-06', commits: 6, weekendCommits: 0, lateNightCommits: 2, mergedPrs: 2, additions: 60, deletions: 5 },
		{ login: 'hubot', owner: 'linagora', repo: 'cozy-home', month: '2026-05', commits: 5, weekendCommits: 0, lateNightCommits: 0, mergedPrs: 0, additions: 0, deletions: 0 },
		{ login: 'stranger', owner: 'linagora', repo: 'cozy-home', month: '2026-05', commits: 99, weekendCommits: 99, lateNightCommits: 99, mergedPrs: 9, additions: 999, deletions: 999 }
	],
	reviewRows: [
		{ reviewer: 'octocat', owner: 'linagora', repo: 'cozy-home', month: '2026-05', reviews: 7, comments: 2 },
		{ reviewer: 'hubot', owner: 'linagora', repo: 'cozy-admin', month: '2026-05', reviews: 3, comments: 1 },
		{ reviewer: 'outsider', owner: 'linagora', repo: 'cozy-home', month: '2026-05', reviews: 20, comments: 30 }
	]
};

describe('assembleMetrics', () => {
	const r = assembleMetrics(rows, members, 123);

	it('sums commits per member per month across repos (members only)', () => {
		expect(r.authors).toContainEqual({ author: 'octocat', month: '2026-05', commits: 14 });
		expect(r.authors).toContainEqual({ author: 'octocat', month: '2026-06', commits: 6 });
		expect(r.authors).toContainEqual({ author: 'hubot', month: '2026-05', commits: 5 });
		expect(r.authors.some((a) => a.author === 'stranger')).toBe(false);
	});

	it('builds per-repo commit breakdown for members', () => {
		expect(r.commitsByAuthorRepo).toContainEqual({ author: 'octocat', repo: 'linagora/cozy-home', commits: 16 });
		expect(r.commitsByAuthorRepo).toContainEqual({ author: 'octocat', repo: 'linagora/cozy-admin', commits: 4 });
	});

	it('sums merged PRs per member per month, dropping zeros', () => {
		expect(r.mergedByAuthor).toContainEqual({ author: 'octocat', month: '2026-05', mergedPRs: 4 });
		expect(r.mergedByAuthor.some((m) => m.author === 'hubot')).toBe(false);
	});

	it('reviews: members tallied, every non-member folded into Others', () => {
		expect(r.reviewActivity).toContainEqual({ author: 'octocat', reviews: 7, comments: 2 });
		expect(r.reviewActivity).toContainEqual({ author: 'hubot', reviews: 3, comments: 1 });
		expect(r.reviewActivity).toContainEqual({ author: 'Others', reviews: 20, comments: 30 });
	});

	it('aggregates issues/bugs per month across repos', () => {
		expect(r.issuesByMonth).toEqual([{ month: '2026-05', tickets: 6, bugs: 2 }]);
	});

	it('sums weekend/late-night commits per member over the window, members only', () => {
		// octocat: 3+1 weekend, 1+2 late-night across the two months; total 20 commits.
		expect(r.workPattern).toContainEqual({ author: 'octocat', commits: 20, weekendCommits: 4, lateNightCommits: 3 });
		expect(r.workPattern).toContainEqual({ author: 'hubot', commits: 5, weekendCommits: 0, lateNightCommits: 0 });
		expect(r.workPattern.some((w) => w.author === 'stranger')).toBe(false); // non-member
	});

	it('sums lines (additions/deletions) per member, members only', () => {
		expect(r.linesByAuthor).toContainEqual({ author: 'octocat', additions: 200, deletions: 35 });
		expect(r.linesByAuthor.some((l) => l.author === 'stranger')).toBe(false);
		expect(r.linesByAuthor.some((l) => l.author === 'hubot')).toBe(false); // no lines
	});
});
