// Pure, client-safe transforms turning parsed metrics into chart-ready series.
// No filesystem or server access here so it can be unit-tested and run in the browser.
import type { AppConfig } from './server/config';
import type { MetricsResult, RepoMonth } from './server/github/types';
import { repoKey } from './client/selection';

export type RepoPoint = {
	month: string;
	created: number;
	merged: number;
	daysPerPr: number;
	addPerPr: number;
	delPerPr: number;
	commentsPerPr: number;
	reviewsPerPr: number;
	bugs: number;
	issues: number;
	issuesOpen: number;
	bugsOpen: number;
	prsOpen: number;
	prsStale: number;
	releases: number;
	resolutionDays: number;
	resolutionStd: number;
	resolutionRate: number;
};

export type RepoSeries = {
	key: string;
	owner: string;
	repo: string;
	label: string;
	points: RepoPoint[];
};

/** Group repo-month rows into one ascending monthly series per repo. */
export function repoSeries(repos: RepoMonth[]): RepoSeries[] {
	const byRepo = new Map<string, RepoSeries>();
	for (const r of repos) {
		const key = repoKey(r);
		let series = byRepo.get(key);
		if (!series) {
			series = { key, owner: r.owner, repo: r.repo, label: r.repo, points: [] };
			byRepo.set(key, series);
		}
		series.points.push({
			month: r.month,
			created: r.created,
			merged: r.merged,
			daysPerPr: r.daysPerPr,
			addPerPr: r.addPerPr,
			delPerPr: r.delPerPr,
			commentsPerPr: r.commentsPerPr,
			reviewsPerPr: r.reviewsPerPr,
			bugs: r.bugs,
			issues: r.issues,
			issuesOpen: r.issuesOpen,
			bugsOpen: r.bugsOpen,
			prsOpen: r.prsOpen,
			prsStale: r.prsStale,
			releases: r.releases,
			resolutionDays: r.resolutionDays,
			resolutionStd: r.resolutionStd,
			resolutionRate: r.resolutionRate
		});
	}
	const all = [...byRepo.values()];
	for (const s of all) s.points.sort((a, b) => a.month.localeCompare(b.month));
	// Busiest repos first (by total merged PRs over the period).
	return all.sort(
		(a, b) =>
			b.points.reduce((n, p) => n + p.merged, 0) - a.points.reduce((n, p) => n + p.merged, 0)
	);
}

export type MemberDatum = { member: string } & Record<string, number>;
export type MemberChart = { months: string[]; data: MemberDatum[]; members: string[] };

/** Logins + display names for every author across the active teams (deduped, config order). */
function activeMembers(config: AppConfig): { login: string; name: string }[] {
	const active = new Set(config.active_teams);
	const seen = new Set<string>();
	const members: { login: string; name: string }[] = [];
	for (const team of config.teams) {
		if (!active.has(team.name)) continue;
		for (const [login, name] of team.authors) {
			if (seen.has(login)) continue;
			seen.add(login);
			members.push({ login, name: name || login });
		}
	}
	return members;
}

/** The last `n` distinct months (ascending). `n <= 0` keeps them all. */
function lastMonths(months: Iterable<string>, n: number): string[] {
	const uniq = [...new Set(months)].sort();
	return n > 0 ? uniq.slice(-n) : uniq;
}

type MemberRow = { author: string; month: string; value: number };

function memberMonthly(rows: MemberRow[], config: AppConfig, monthsBack: number): MemberChart {
	const members = activeMembers(config);
	const loginToName = new Map(members.map((m) => [m.login, m.name]));
	const memberLogins = new Set(members.map((m) => m.login));

	const relevant = rows.filter((r) => memberLogins.has(r.author));
	const months = lastMonths(
		relevant.map((r) => r.month),
		monthsBack
	);
	const monthSet = new Set(months);

	const acc = new Map<string, Map<string, number>>();
	for (const r of relevant) {
		if (!monthSet.has(r.month)) continue;
		const name = loginToName.get(r.author)!;
		const perMonth = acc.get(name) ?? new Map<string, number>();
		perMonth.set(r.month, (perMonth.get(r.month) ?? 0) + r.value);
		acc.set(name, perMonth);
	}

	const data: MemberDatum[] = members.map((m) => {
		const datum = { member: m.name } as MemberDatum;
		const perMonth = acc.get(m.name);
		for (const month of months) datum[month] = perMonth?.get(month) ?? 0;
		return datum;
	});

	return { months, data, members: members.map((m) => m.name) };
}

export function commitsChart(data: MetricsResult, config: AppConfig): MemberChart {
	return memberMonthly(
		data.authors.map((a) => ({ author: a.author, month: a.month, value: a.commits })),
		config,
		config.commit_months
	);
}

export function mergedPrChart(data: MetricsResult, config: AppConfig): MemberChart {
	return memberMonthly(
		data.mergedByAuthor.map((a) => ({ author: a.author, month: a.month, value: a.mergedPRs })),
		config,
		config.commit_months
	);
}

export type ReviewDatum = { name: string; reviews: number; comments: number };

/** Per-member review + PR-comment activity, with non-team authors folded into "Others". */
export function reviewActivityChart(data: MetricsResult, config: AppConfig): ReviewDatum[] {
	const members = activeMembers(config);
	const loginToName = new Map(members.map((m) => [m.login, m.name]));
	const result = new Map<string, ReviewDatum>(
		members.map((m) => [m.name, { name: m.name, reviews: 0, comments: 0 }])
	);
	const others: ReviewDatum = { name: 'Others', reviews: 0, comments: 0 };

	for (const r of data.reviewActivity) {
		const name = loginToName.get(r.author);
		const target = name ? result.get(name)! : others;
		target.reviews += r.reviews;
		target.comments += r.comments;
	}

	const arr = [...result.values()];
	if (others.reviews || others.comments) arr.push(others);
	return arr;
}

export type TicketDatum = { month: string; tickets: number; bugs: number };

/** Team-wide tickets vs bugs created per month (ascending). */
export function ticketsChart(data: MetricsResult): TicketDatum[] {
	return data.issuesByMonth.map((m) => ({ month: m.month, tickets: m.tickets, bugs: m.bugs }));
}

export type CommitsByRepoDatum = { repo: string } & Record<string, number>;
export type CommitsByRepoChart = { repos: string[]; data: CommitsByRepoDatum[]; members: string[] };

/** Commits per member, broken down by repository (stacked bars, one bar per repo). */
export function commitsByRepoChart(data: MetricsResult, config: AppConfig): CommitsByRepoChart {
	const members = activeMembers(config);
	const memberLogins = new Set(members.map((m) => m.login));

	// Key by login, not display name: the series key becomes a `--color-<key>` CSS
	// variable in the chart, and names contain spaces (invalid var names) which left
	// the bars uncolored/invisible. The page maps login -> name for the legend.
	const byRepo = new Map<string, Map<string, number>>(); // repo -> login -> commits
	for (const c of data.commitsByAuthorRepo) {
		if (!memberLogins.has(c.author)) continue;
		const perMember = byRepo.get(c.repo) ?? new Map<string, number>();
		perMember.set(c.author, (perMember.get(c.author) ?? 0) + c.commits);
		byRepo.set(c.repo, perMember);
	}

	// Show the short repo name, busiest first.
	const repoKeys = [...byRepo.keys()].sort(
		(a, b) => sum(byRepo.get(b)!) - sum(byRepo.get(a)!)
	);
	const datums: CommitsByRepoDatum[] = repoKeys.map((repo) => {
		const datum = { repo: repo.split('/').pop() ?? repo } as CommitsByRepoDatum;
		const perMember = byRepo.get(repo)!;
		for (const m of members) datum[m.login] = perMember.get(m.login) ?? 0;
		return datum;
	});

	return { repos: repoKeys, data: datums, members: members.map((m) => m.login) };
}

function sum(m: Map<string, number>): number {
	let t = 0;
	for (const v of m.values()) t += v;
	return t;
}

export type OrgMonth = {
	month: string;
	created: number;
	merged: number;
	closed: number;
	mergeRate: number; // %
	additions: number; // total lines added (merged PRs)
	deletions: number; // total lines removed (merged PRs)
	churn: number; // additions + deletions
	releases: number;
	bugs: number;
	issues: number;
	daysPerPr: number; // merged-weighted avg of repo medians
	linesPerPr: number; // add+del, merged-weighted
	interactionsPerPr: number; // comments+reviews, created-weighted
};

/** Aggregate per-repo-month rows into one org-wide monthly trend (ascending).
 * Counts are exact sums; per-PR figures are weighted averages of repo medians. */
export function orgTrend(repos: RepoMonth[]): OrgMonth[] {
	type Acc = {
		created: number;
		merged: number;
		closed: number;
		additions: number;
		deletions: number;
		releases: number;
		bugs: number;
		issues: number;
		daysW: number;
		linesW: number;
		interW: number;
	};
	const by = new Map<string, Acc>();
	for (const r of repos) {
		const a =
			by.get(r.month) ??
			{ created: 0, merged: 0, closed: 0, additions: 0, deletions: 0, releases: 0, bugs: 0, issues: 0, daysW: 0, linesW: 0, interW: 0 };
		a.created += r.created;
		a.merged += r.merged;
		a.closed += r.closed;
		a.additions += r.additions;
		a.deletions += r.deletions;
		a.releases += r.releases;
		a.bugs += r.bugs;
		a.issues += r.issues;
		a.daysW += r.daysPerPr * r.merged;
		a.linesW += (r.addPerPr + r.delPerPr) * r.merged;
		a.interW += (r.commentsPerPr + r.reviewsPerPr) * r.created;
		by.set(r.month, a);
	}
	return [...by.entries()]
		.map(([month, a]) => ({
			month,
			created: a.created,
			merged: a.merged,
			closed: a.closed,
			mergeRate: a.closed > 0 ? Math.round((a.merged / a.closed) * 1000) / 10 : 0,
			additions: a.additions,
			deletions: a.deletions,
			churn: a.additions + a.deletions,
			releases: a.releases,
			bugs: a.bugs,
			issues: a.issues,
			daysPerPr: a.merged > 0 ? Math.round((a.daysW / a.merged) * 100) / 100 : 0,
			linesPerPr: a.merged > 0 ? Math.round(a.linesW / a.merged) : 0,
			interactionsPerPr: a.created > 0 ? Math.round((a.interW / a.created) * 100) / 100 : 0
		}))
		.sort((x, y) => x.month.localeCompare(y.month));
}

/** Average a numeric field over a slice of org months (for before/after panels). */
export function avgOver(rows: OrgMonth[], key: keyof OrgMonth): number {
	const nums = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
	if (!nums.length) return 0;
	return nums.reduce((s, v) => s + v, 0) / nums.length;
}
