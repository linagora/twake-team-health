import { describe, it, expect } from 'vitest';
import {
	repoSeries,
	commitsChart,
	mergedPrChart,
	reviewActivityChart,
	ticketsChart
} from './charts';
import { commitsByRepoChart, orgTrend, avgOver } from './charts';
import type { AppConfig } from './server/config';
import type { MetricsResult, RepoMonth } from './server/github/types';

const CONFIG: AppConfig = {
	months: 12,
	commit_months: 2,
	repo_list: [],
	active_teams: ['team'],
	teams: [
		{
			name: 'team',
			authors: [
				['octocat', 'octocat', ''],
				['hubot', 'hubot', '']
			],
			repos: []
		}
	]
};

function repoMonth(over: Partial<RepoMonth>): RepoMonth {
	return {
		owner: 'linagora',
		repo: 'cozy-home',
		month: '2025-05',
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
	};
}

const DATA: MetricsResult = {
	repos: [
		repoMonth({ repo: 'cozy-home', month: '2025-06', merged: 2 }),
		repoMonth({ repo: 'cozy-home', month: '2025-05', merged: 5 }),
		repoMonth({ repo: 'cozy-admin', month: '2025-05', merged: 1 })
	],
	authors: [
		{ author: 'octocat', month: '2026-01', commits: 10 },
		{ author: 'octocat', month: '2026-02', commits: 20 },
		{ author: 'octocat', month: '2026-03', commits: 30 },
		{ author: 'hubot', month: '2026-03', commits: 5 }
	],
	mergedByAuthor: [{ author: 'octocat', month: '2026-03', mergedPRs: 7 }],
	reviewActivity: [
		{ author: 'octocat', reviews: 3, comments: 2 },
		{ author: 'outsider', reviews: 4, comments: 1 }
	],
	issuesByMonth: [{ month: '2025-05', tickets: 3, bugs: 2 }],
	commitsByAuthorRepo: [
		{ author: 'octocat', repo: 'linagora/cozy-home', commits: 12 },
		{ author: 'hubot', repo: 'linagora/cozy-home', commits: 3 },
		{ author: 'octocat', repo: 'linagora/cozy-admin', commits: 4 },
		{ author: 'outsider', repo: 'linagora/cozy-home', commits: 99 }
	],
	linesByAuthor: [],
	workPattern: [],
	generatedAt: 0
};

describe('repoSeries', () => {
	const series = repoSeries(DATA.repos);

	it('groups by repo and sorts points ascending by month', () => {
		const home = series.find((s) => s.repo === 'cozy-home')!;
		expect(home.points.map((p) => p.month)).toEqual(['2025-05', '2025-06']);
	});

	it('orders repos by total merged PRs descending', () => {
		expect(series.map((s) => s.repo)).toEqual(['cozy-home', 'cozy-admin']);
	});
});

describe('memberMonthly charts', () => {
	it('keeps only the last commit_months months and maps logins to display names', () => {
		const c = commitsChart(DATA, CONFIG);
		expect(c.months).toEqual(['2026-02', '2026-03']); // commit_months = 2
		expect(c.members).toEqual(['octocat', 'hubot']);
		const octocat = c.data.find((d) => d.member === 'octocat')!;
		expect(octocat['2026-02']).toBe(20);
		expect(octocat['2026-03']).toBe(30);
		// hubot only committed in 2026-03; missing months fill with 0
		const hubot = c.data.find((d) => d.member === 'hubot')!;
		expect(hubot['2026-02']).toBe(0);
		expect(hubot['2026-03']).toBe(5);
	});

	it('builds merged-PR member chart from mergedByAuthor', () => {
		const m = mergedPrChart(DATA, CONFIG);
		const octocat = m.data.find((d) => d.member === 'octocat')!;
		expect(octocat['2026-03']).toBe(7);
	});
});

describe('reviewActivityChart', () => {
	it('keeps team members and folds non-members into Others', () => {
		const r = reviewActivityChart(DATA, CONFIG);
		expect(r.find((d) => d.name === 'octocat')).toEqual({ name: 'octocat', reviews: 3, comments: 2 });
		expect(r.find((d) => d.name === 'hubot')).toEqual({ name: 'hubot', reviews: 0, comments: 0 });
		expect(r.find((d) => d.name === 'Others')).toEqual({ name: 'Others', reviews: 4, comments: 1 });
	});
});

describe('ticketsChart', () => {
	it('builds per-repo commit breakdown for team members, dropping non-members', () => {
		const c = commitsByRepoChart(DATA, CONFIG);
		expect(c.members).toEqual(['octocat', 'hubot']);
		const home = c.data.find((d) => d.repo === 'cozy-home')!;
		expect(home.octocat).toBe(12);
		expect(home.hubot).toBe(3); // hubot -> hubot
		const admin = c.data.find((d) => d.repo === 'cozy-admin')!;
		expect(admin.octocat).toBe(4);
		// 'outsider' is not a team member and is excluded entirely
		expect(c.data.every((d) => !('outsider' in d))).toBe(true);
	});
});

describe('ticketsChart', () => {
	it('passes through monthly tickets vs bugs', () => {
		expect(ticketsChart(DATA)).toEqual([{ month: '2025-05', tickets: 3, bugs: 2 }]);
	});
});

describe('orgTrend', () => {
	const rows: RepoMonth[] = [
		repoMonth({ repo: 'a', month: '2026-05', created: 3, merged: 2, closed: 2, addPerPr: 10, delPerPr: 2, daysPerPr: 1, commentsPerPr: 1, reviewsPerPr: 1, releases: 1, bugs: 1, issues: 2 }),
		repoMonth({ repo: 'b', month: '2026-05', created: 1, merged: 0, closed: 1, releases: 0, bugs: 0, issues: 1 }),
		repoMonth({ repo: 'a', month: '2026-06', created: 2, merged: 2, closed: 2, addPerPr: 4, delPerPr: 0, daysPerPr: 0.5, releases: 1, bugs: 0, issues: 0 })
	];
	const trend = orgTrend(rows);

	it('sums counts and computes merge rate per month, ascending', () => {
		expect(trend.map((t) => t.month)).toEqual(['2026-05', '2026-06']);
		const may = trend[0];
		expect(may).toMatchObject({ created: 4, merged: 2, closed: 3, releases: 1, bugs: 1, issues: 3 });
		expect(may.mergeRate).toBe(66.7); // 2 merged / 3 closed
	});

	it('weights per-PR figures by the relevant count', () => {
		const may = trend[0];
		expect(may.daysPerPr).toBe(1); // (1*2 + 0*0)/2
		expect(may.linesPerPr).toBe(12); // ((10+2)*2 + 0)/2
		expect(may.interactionsPerPr).toBe(1.5); // ((1+1)*3 + 0)/4
	});

	it('avgOver averages a field across months', () => {
		expect(avgOver(trend, 'merged')).toBe(2); // (2 + 2)/2
	});
});
