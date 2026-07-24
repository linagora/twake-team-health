// Facts → report rows. This is where windows are applied: calendar-month
// buckets for the trend series (whichever months resolveReportShape asks for,
// which on a rolling selection includes the in-progress one) and rolling 30-day
// windows for the headline/leaderboard numbers. Rows are zero-filled per (repo,
// month), so an in-progress month with no activity yet reads as literal zeros
// rather than as an absent bucket; callers that average or draw ratios have to
// account for that. All classification happens here, at read time: the bug
// matcher (config change = retroactive), member attribution (roster change =
// retroactive), and local-time burnout classification (timezone change =
// retroactive). The monthly bucket math reuses the same pure per-month stat
// functions the legacy monthly fetch used, so numbers reconcile by construction.
import {
	prStatsForMonth,
	issueStatsForMonth,
	classifyCommitTime,
	weekIdOf,
	pickCommitMember,
} from '../github/metrics';
import type { BugSignal } from '../github/stats';
import { monthKey, monthEnd, monthStartMs, monthEndMs, type Month } from '../github/months';
import { rollingWindows, dayOf, addDays, type MsWindow } from '../days';
import type { StoredRows, MemberRepoMonthRow, ReviewRepoMonthRow } from './assemble';
import type {
	FactBundle,
	Member,
	Repo,
	RepoMonth,
	RecentMember,
	RecentRepo,
	DailyCount,
	WorkPattern,
	Window30d,
	WindowCounts,
	CommitFact,
} from '../github/types';

export type AggregateOptions = {
	repos: Repo[];
	members: Member[];
	/** Complete months for the repo-level series, ascending. */
	months: Month[];
	/** Complete months for the member/review series, ascending (suffix of months). */
	memberMonths: Month[];
	isBug: (s: BugSignal) => boolean;
};

const rk = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;
const inWin = (d: Date | null, w: MsWindow): boolean =>
	d !== null && d.getTime() >= w.startMs && d.getTime() <= w.endMs;

/** Member attribution maps, built once per aggregation (same rules the legacy
 * fetch used: linked login wins, unique member email is the only fallback). */
function memberMaps(members: Member[]) {
	const byLogin = new Map(members.map((m) => [m.login.toLowerCase(), m.login]));
	const tzByLogin = new Map(members.map((m) => [m.login, m.tz]));
	const emailOwners = new Map<string, Set<string>>();
	for (const m of members) {
		if (!m.email) continue;
		const k = m.email.toLowerCase();
		(emailOwners.get(k) ?? emailOwners.set(k, new Set()).get(k)!).add(m.login);
	}
	const byEmail = new Map(
		[...emailOwners].filter(([, o]) => o.size === 1).map(([k, o]) => [k, [...o][0]]),
	);
	return { byLogin, byEmail, tzByLogin };
}

const commitAuthor = (c: CommitFact) =>
	({
		email: c.authorEmail,
		user: c.authorLogin ? { login: c.authorLogin } : null,
	}) as const;

/** Fold facts into the same StoredRows shape the legacy monthly store produced,
 * bucketed by the given months. Repo rows are zero-filled so charts never show a
 * gap for a quiet month. */
export function buildStoredRows(bundle: FactBundle, opts: AggregateOptions): StoredRows {
	const { repos, members, months, memberMonths, isBug } = opts;
	const monthWindows = months.map((m) => ({
		m,
		key: monthKey(m),
		startMs: monthStartMs(m),
		endMs: monthEndMs(m),
	}));
	const memberKeys = new Set(memberMonths.map(monthKey));

	// Group facts by repo once; each bucket pass then only scans its own repo.
	const byRepo = <T extends { owner: string; repo: string }>(xs: T[]) => {
		const g = new Map<string, T[]>();
		for (const x of xs) {
			const k = rk(x);
			(g.get(k) ?? g.set(k, []).get(k)!).push(x);
		}
		return g;
	};
	const prsByRepo = byRepo(bundle.prs);
	const issuesByRepo = byRepo(bundle.issues);
	const releasesByRepo = byRepo(bundle.releases);
	const stocksByRepo = byRepo(bundle.stocks);
	const commitsByRepo = byRepo(bundle.commits);
	const reviewsByRepo = byRepo(bundle.reviews);

	// --- repo_month-equivalent rows, zero-filled per (repo, month) -------------
	const repoRows: RepoMonth[] = [];
	for (const repo of repos) {
		const key = rk(repo);
		const prs = prsByRepo.get(key) ?? [];
		const issues = issuesByRepo.get(key) ?? [];
		const releases = releasesByRepo.get(key) ?? [];
		// Snapshots sorted by day so each month picks the latest at or before its end.
		const stocks = (stocksByRepo.get(key) ?? []).slice().sort((a, b) => a.day.localeCompare(b.day));
		for (const { m, key: mk, startMs, endMs } of monthWindows) {
			const win: MsWindow = { startMs, endMs };
			const mergedCohort = prs.filter((p) => inWin(p.mergedAt, win));
			const pr = prStatsForMonth(
				{
					issueCount: mergedCohort.length,
					nodes: mergedCohort.map((p) => ({
						additions: p.additions,
						deletions: p.deletions,
						createdAt: p.createdAt.toISOString(),
						mergedAt: p.mergedAt!.toISOString(),
						comments: { totalCount: p.comments },
						reviews: { totalCount: p.reviews },
					})),
				},
				prs.filter((p) => inWin(p.createdAt, win)).length,
				prs.filter((p) => inWin(p.closedAt, win)).length,
			);
			const openedCohort = issues.filter((i) => inWin(i.createdAt, win));
			const iss = issueStatsForMonth(
				{
					issueCount: openedCohort.length,
					nodes: openedCohort.map((i) => ({
						createdAt: i.createdAt.toISOString(),
						closedAt: i.closedAt ? i.closedAt.toISOString() : null,
						labels: { nodes: i.labels.map((name) => ({ name })) },
						issueType: i.issueType,
					})),
				},
				issues.filter((i) => inWin(i.closedAt, win)).length,
				isBug,
			);
			const monthEndDay = monthEnd(m);
			const stock = [...stocks].reverse().find((s) => s.day <= monthEndDay);
			repoRows.push({
				owner: repo.owner,
				repo: repo.repo,
				month: mk,
				...pr,
				bugs: iss.bugs,
				issues: iss.opened,
				issuesOpen: stock?.issuesOpen ?? 0,
				bugsOpen: stock?.bugsOpen ?? 0,
				prsOpen: stock?.prsOpen ?? 0,
				releases: releases.filter((r) => inWin(r.publishedAt, win)).length,
				resolutionDays: iss.resolutionDays,
				resolutionRate: iss.resolutionRate,
			});
		}
	}

	// --- member_repo_month-equivalent rows (member window only) ----------------
	const { byLogin, byEmail, tzByLogin } = memberMaps(members);
	const acc = new Map<string, MemberRepoMonthRow>();
	const row = (login: string, owner: string, repo: string, month: string) => {
		const k = `${login}::${owner}/${repo}::${month}`;
		let r = acc.get(k);
		if (!r) {
			r = {
				login,
				owner,
				repo,
				month,
				commits: 0,
				weekendCommits: 0,
				lateNightCommits: 0,
				activeWeeks: [],
				mergedPrs: 0,
				additions: 0,
				deletions: 0,
			};
			acc.set(k, r);
		}
		return r;
	};
	for (const repo of repos) {
		const key = rk(repo);
		for (const c of commitsByRepo.get(key) ?? []) {
			const mk = monthKey({
				year: c.committedAt.getUTCFullYear(),
				month: c.committedAt.getUTCMonth() + 1,
			});
			if (!memberKeys.has(mk)) continue;
			const login = pickCommitMember(commitAuthor(c), byLogin, byEmail);
			if (!login) continue;
			const tz = tzByLogin.get(login);
			const r = row(login, repo.owner, repo.repo, mk);
			r.commits += 1;
			const cls = classifyCommitTime(c.committedDate, tz);
			if (cls.weekend) r.weekendCommits += 1;
			if (cls.lateNight) r.lateNightCommits += 1;
			const week = weekIdOf(c.committedDate, tz);
			if (week !== null && !r.activeWeeks.includes(week)) r.activeWeeks.push(week);
		}
		for (const p of prsByRepo.get(key) ?? []) {
			if (!p.mergedAt || !p.author) continue;
			const mk = monthKey({
				year: p.mergedAt.getUTCFullYear(),
				month: p.mergedAt.getUTCMonth() + 1,
			});
			if (!memberKeys.has(mk)) continue;
			const login = byLogin.get(p.author.toLowerCase());
			if (!login) continue;
			const r = row(login, repo.owner, repo.repo, mk);
			r.mergedPrs += 1;
			r.additions += p.additions;
			r.deletions += p.deletions;
		}
	}

	// --- review_repo_month-equivalent rows (all reviewers; assemble buckets
	// non-members into "Others") ------------------------------------------------
	const rev = new Map<string, ReviewRepoMonthRow>();
	for (const repo of repos) {
		for (const f of reviewsByRepo.get(rk(repo)) ?? []) {
			// Self-activity and unsubmitted reviews are not review work.
			if (f.prAuthor && f.reviewer === f.prAuthor) continue;
			if (f.state === 'PENDING') continue;
			const mk = monthKey({
				year: f.ts.getUTCFullYear(),
				month: f.ts.getUTCMonth() + 1,
			});
			if (!memberKeys.has(mk)) continue;
			const k = `${f.reviewer}::${rk(repo)}::${mk}`;
			let r = rev.get(k);
			if (!r) {
				r = {
					reviewer: f.reviewer,
					owner: repo.owner,
					repo: repo.repo,
					month: mk,
					reviews: 0,
					comments: 0,
				};
				rev.set(k, r);
			}
			if (f.kind === 'review') r.reviews += 1;
			else r.comments += 1;
		}
	}

	return {
		repoRows,
		memberRows: [...acc.values()],
		reviewRows: [...rev.values()],
	};
}

// --- rolling trailing-30d aggregation (headline + leaderboards) ---------------

export type RecentActivity = {
	window30d: Window30d;
	recentMembers: RecentMember[];
	recentRepos: RecentRepo[];
	recentDaily: DailyCount[];
	recentWorkPattern: WorkPattern[];
};

/** Trailing-30d and prior-30d activity, ending at `endDay` (usually today). */
export function aggregateRecent(
	bundle: FactBundle,
	repos: Repo[],
	members: Member[],
	isBug: (s: BugSignal) => boolean,
	endDay: string,
	generatedAt: number,
): RecentActivity {
	const { current, previous } = rollingWindows(endDay);
	const want = new Set(repos.map(rk));
	const prs = bundle.prs.filter((p) => want.has(rk(p)));
	const issues = bundle.issues.filter((i) => want.has(rk(i)));

	const counts = (w: MsWindow): WindowCounts => ({
		created: prs.filter((p) => inWin(p.createdAt, w)).length,
		merged: prs.filter((p) => inWin(p.mergedAt, w)).length,
		issues: issues.filter((i) => inWin(i.createdAt, w)).length,
		bugs: issues.filter((i) => inWin(i.createdAt, w) && isBug(i)).length,
	});

	const { byLogin, byEmail, tzByLogin } = memberMaps(members);
	const byMember = new Map<string, RecentMember>();
	const member = (login: string) => {
		let r = byMember.get(login);
		if (!r) {
			r = {
				login,
				commits: 0,
				mergedPrs: 0,
				additions: 0,
				deletions: 0,
				reviews: 0,
				comments: 0,
				repos: 0,
			};
			byMember.set(login, r);
		}
		return r;
	};
	// Distinct repos each member committed to in the current window (breadth award),
	// plus the local-time work pattern (weekend / late-night / active weeks) that
	// feeds the rolling burnout signal.
	const reposByMember = new Map<string, Set<string>>();
	type WP = { commits: number; weekend: number; lateNight: number; weeks: Set<number> };
	const wpByMember = new Map<string, WP>();
	for (const c of bundle.commits) {
		if (!want.has(rk(c)) || !inWin(c.committedAt, current)) continue;
		const login = pickCommitMember(commitAuthor(c), byLogin, byEmail);
		if (!login) continue;
		member(login).commits += 1;
		(reposByMember.get(login) ?? reposByMember.set(login, new Set()).get(login)!).add(rk(c));
		const tz = tzByLogin.get(login);
		const wp = wpByMember.get(login) ?? { commits: 0, weekend: 0, lateNight: 0, weeks: new Set<number>() };
		wp.commits += 1;
		const cls = classifyCommitTime(c.committedDate, tz);
		if (cls.weekend) wp.weekend += 1;
		if (cls.lateNight) wp.lateNight += 1;
		const week = weekIdOf(c.committedDate, tz);
		if (week !== null) wp.weeks.add(week);
		wpByMember.set(login, wp);
	}
	for (const p of prs) {
		if (!p.author || !inWin(p.mergedAt, current)) continue;
		const login = byLogin.get(p.author.toLowerCase());
		if (!login) continue;
		const r = member(login);
		r.mergedPrs += 1;
		r.additions += p.additions;
		r.deletions += p.deletions;
	}
	for (const f of bundle.reviews) {
		if (!want.has(rk(f)) || !inWin(f.ts, current)) continue;
		if (f.prAuthor && f.reviewer === f.prAuthor) continue;
		if (f.state === 'PENDING') continue;
		const login = byLogin.get(f.reviewer.toLowerCase());
		if (!login) continue;
		if (f.kind === 'review') member(login).reviews += 1;
		else member(login).comments += 1;
	}
	for (const [login, set] of reposByMember) member(login).repos = set.size;

	// Per-repo trailing-30d activity (current vs previous window) for the
	// "most active repositories" list, so it stops summing calendar months.
	const recentRepos: RecentRepo[] = repos.map((repo) => {
		const key = rk(repo);
		const rp = prs.filter((p) => rk(p) === key);
		const ri = issues.filter((i) => rk(i) === key);
		const rc = (w: MsWindow): WindowCounts => ({
			created: rp.filter((p) => inWin(p.createdAt, w)).length,
			merged: rp.filter((p) => inWin(p.mergedAt, w)).length,
			issues: ri.filter((i) => inWin(i.createdAt, w)).length,
			bugs: ri.filter((i) => inWin(i.createdAt, w) && isBug(i)).length,
		});
		return { owner: repo.owner, repo: repo.repo, current: rc(current), previous: rc(previous) };
	});

	// Daily headline counts across the whole 2N-day span (previous + current
	// window), zero-filled so the sparkline is continuous.
	const daily: DailyCount[] = [];
	const dayIdx = new Map<string, number>();
	for (let day = dayOf(new Date(previous.startMs)); day <= endDay; day = addDays(day, 1)) {
		dayIdx.set(day, daily.length);
		daily.push({ day, created: 0, merged: 0, bugs: 0 });
	}
	const bumpDay = (date: Date | null, field: 'created' | 'merged' | 'bugs') => {
		if (!date) return;
		const i = dayIdx.get(dayOf(date));
		if (i !== undefined) daily[i][field] += 1;
	};
	for (const p of prs) {
		bumpDay(p.createdAt, 'created');
		bumpDay(p.mergedAt, 'merged');
	}
	for (const i of issues) {
		if (isBug(i)) bumpDay(i.createdAt, 'bugs');
	}

	return {
		window30d: {
			current: counts(current),
			previous: counts(previous),
			computedAt: generatedAt,
		},
		recentMembers: [...byMember.values()].sort((a, b) => b.commits - a.commits),
		recentRepos,
		recentDaily: daily,
		recentWorkPattern: [...wpByMember.entries()].map(([author, wp]) => ({
			author,
			commits: wp.commits,
			weekendCommits: wp.weekend,
			lateNightCommits: wp.lateNight,
			activeWeeks: [...wp.weeks].sort((a, b) => a - b),
		})),
	};
}
