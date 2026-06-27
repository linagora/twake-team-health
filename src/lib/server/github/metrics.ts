import { type GraphQL } from './client';
import { median, std, round, isBugLabel, makeBugMatcher } from './stats';
import { type Month, monthKey, monthStart, monthEnd, monthStartMs, monthEndMs } from './months';
import type { Repo, Member, RepoMonth, OpenPr, PrFlow, BotActivity, BotMonthActivity } from './types';
import type { MemberRepoMonthRow, ReviewRepoMonthRow } from '../store/assemble';

// Heavy first:100 search aliases trip GitHub's per-query resource limit beyond
// ~4-5 at once, so every multi-alias query is built in chunks of this size.
const ALIASES_PER_QUERY = 3;
const DAY_MS = 86_400_000;

function chunk<T>(arr: T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
}

// ---------------------------------------------------------------------------
// Pure aggregators (no I/O) — unit-tested against fixture GraphQL nodes.
// ---------------------------------------------------------------------------

type MergedPrNode = {
	additions: number;
	deletions: number;
	createdAt: string;
	mergedAt: string;
	comments: { totalCount: number };
	reviews: { totalCount: number };
};

export type PrStats = Pick<
	RepoMonth,
	| 'created'
	| 'merged'
	| 'closed'
	| 'additions'
	| 'deletions'
	| 'addPerPr'
	| 'delPerPr'
	| 'daysPerPr'
	| 'commentsPerPr'
	| 'reviewsPerPr'
>;

/** Code-volume, lead-time, and engagement stats over the PRs MERGED in the month
 * (so they reconcile with the merged count and the per-member rollup). `created`
 * and `closed` are independent counts. */
export function prStatsForMonth(
	merged: { issueCount: number; nodes: MergedPrNode[] },
	createdCount: number,
	closedCount: number
): PrStats {
	const adds: number[] = [];
	const dels: number[] = [];
	const days: number[] = [];
	const comments: number[] = [];
	const reviews: number[] = [];

	for (const pr of merged.nodes) {
		if (!pr) continue; // partial 200s can null individual nodes
		adds.push(pr.additions);
		dels.push(pr.deletions);
		comments.push(pr.comments?.totalCount ?? 0);
		reviews.push(pr.reviews?.totalCount ?? 0);
		days.push(round((Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / DAY_MS, 2));
	}

	const total = merged.issueCount;
	const sumOf = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
	return {
		created: createdCount,
		merged: total,
		closed: closedCount,
		additions: sumOf(adds),
		deletions: sumOf(dels),
		addPerPr: adds.length ? round(median(adds)) : 0,
		delPerPr: dels.length ? round(median(dels)) : 0,
		daysPerPr: days.length ? round(median(days), 2) : 0,
		commentsPerPr: total > 0 ? round(median(comments), 2) : 0,
		reviewsPerPr: total > 0 ? round(median(reviews), 2) : 0
	};
}

type IssueNode = {
	createdAt: string;
	closedAt: string | null;
	labels: { nodes: { name: string }[] };
};

export function issueStatsForMonth(
	opened: { issueCount: number; nodes: IssueNode[] },
	closedCount: number,
	isBug: (labels: string[]) => boolean = isBugLabel
): { opened: number; closed: number; bugs: number; resolutionDays: number; resolutionStd: number; resolutionRate: number } {
	let bugs = 0;
	const resolutionDaysList: number[] = [];
	for (const issue of opened.nodes) {
		const labels = issue.labels.nodes.map((l) => l.name);
		if (isBug(labels)) {
			bugs += 1;
			if (issue.closedAt) {
				resolutionDaysList.push(
					round((Date.parse(issue.closedAt) - Date.parse(issue.createdAt)) / DAY_MS, 2)
				);
			}
		}
	}
	return {
		opened: opened.issueCount,
		closed: closedCount,
		bugs,
		resolutionDays: resolutionDaysList.length ? round(median(resolutionDaysList), 2) : 0,
		resolutionStd: std(resolutionDaysList),
		resolutionRate: bugs > 0 ? round((resolutionDaysList.length / bugs) * 100, 1) : 0
	};
}

type ReviewPrNode = {
	author: { login: string } | null;
	reviews: { nodes: { author: { login: string } | null; submittedAt: string | null; state: string }[] };
	comments: { nodes: { author: { login: string } | null; createdAt: string }[] };
};

type CommitNode = { oid: string; committedDate: string; author: { email: string | null; user: { login: string } | null } };

/** Attribute a commit to exactly one member: a linked GitHub login wins, then a
 * (non-shared) author email, else nobody. One member per commit avoids the
 * double-count where login and email point at different people. */
export function pickCommitMember(
	author: CommitNode['author'] | null,
	byLogin: Map<string, string>,
	byEmail: Map<string, string>
): string | null {
	if (!author) return null;
	// A linked GitHub identity is authoritative: if the commit has a user, attribute
	// to that member or to nobody. Email is only a fallback for commits with no
	// linked user (otherwise a member's email could steal a non-member's commit).
	if (author.user) return byLogin.get(author.user.login.toLowerCase()) ?? null;
	return (author.email && byEmail.get(author.email.toLowerCase())) || null;
}

// ---------------------------------------------------------------------------
// Fetchers (build queries, call GraphQL) — thin around the pure aggregators.
// ---------------------------------------------------------------------------

async function runChunkedAliases(
	gql: GraphQL,
	aliasBlocks: string[],
	perQuery = ALIASES_PER_QUERY
): Promise<Record<string, any>> {
	const merged: Record<string, any> = {};
	for (const group of chunk(aliasBlocks, perQuery)) {
		const data = await gql('{\n' + group.join('\n') + '\n}');
		Object.assign(merged, data);
	}
	return merged;
}

// Node selections shared by the alias block and the pagination drainer so both
// request identical fields.
// Code-volume + lead-time stats are computed over the MERGED cohort (PRs merged
// in the month), so they reconcile with the merged count and the per-member
// rollup, which also use the merged cohort.
const MERGED_VOLUME_FIELDS = `... on PullRequest { additions deletions createdAt mergedAt comments { totalCount } reviews { totalCount } }`;
const ISSUE_NODE_FIELDS = `... on Issue { createdAt closedAt labels(first: 10) { nodes { name } } }`;
const MERGED_PR_NODE_FIELDS = `... on PullRequest { author { login } additions deletions }`;
const REVIEW_PR_NODE_FIELDS = `... on PullRequest { author { login } reviews(first: 50) { nodes { author { login } submittedAt state } } comments(first: 100) { nodes { author { login } createdAt } } }`;
const FLOW_PR_NODE_FIELDS = `... on PullRequest { createdAt mergedAt reviews(first: 100) { nodes { submittedAt state author { login __typename } comments { totalCount } } } }`;
const mergedVolumeQuery = (owner: string, repo: string, m: Month) =>
	`repo:${owner}/${repo} type:pr is:merged merged:${monthStart(m)}..${monthEnd(m)} sort:created-asc`;
const openedIssueQuery = (owner: string, repo: string, m: Month) =>
	`repo:${owner}/${repo} type:issue created:${monthStart(m)}..${monthEnd(m)} sort:created-asc`;

/** Collect every node of a search, draining past the first 100 (GitHub Search
 * caps the total result set at 1000). `first` is the already-fetched first page. */
async function drainSearchNodes(
	gql: GraphQL,
	query: string,
	fields: string,
	first: { nodes?: any[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }
): Promise<any[]> {
	const nodes = [...(first.nodes ?? [])];
	let cursor = first.pageInfo?.hasNextPage ? first.pageInfo.endCursor : null;
	let guard = 0;
	while (cursor && guard++ < 12) {
		const data: any = await gql(
			`{ search(query: ${JSON.stringify(query)}, type: ISSUE, first: 100, after: "${cursor}") {
        nodes { ${fields} } pageInfo { hasNextPage endCursor }
      } }`
		);
		const sr = data.search;
		if (!sr) break;
		nodes.push(...(sr.nodes ?? []));
		cursor = sr.pageInfo?.hasNextPage ? sr.pageInfo.endCursor : null;
	}
	return nodes;
}

function prAliasBlock(owner: string, repo: string, m: Month, i: number): string {
	const s = monthStart(m);
	const e = monthEnd(m);
	return `
    created_${i}: search(query: "repo:${owner}/${repo} type:pr created:${s}..${e}", type: ISSUE, first: 1) { issueCount }
    merged_${i}: search(query: "${mergedVolumeQuery(owner, repo, m)}", type: ISSUE, first: 100) {
      issueCount
      nodes { ${MERGED_VOLUME_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
    closed_${i}: search(query: "repo:${owner}/${repo} type:pr is:closed closed:${s}..${e}", type: ISSUE, first: 1) { issueCount }`;
}

function issueAliasBlock(owner: string, repo: string, m: Month, i: number): string {
	const s = monthStart(m);
	const e = monthEnd(m);
	return `
    opened_${i}: search(query: "${openedIssueQuery(owner, repo, m)}", type: ISSUE, first: 100) {
      issueCount
      nodes { ${ISSUE_NODE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
    closed_${i}: search(query: "repo:${owner}/${repo} type:issue is:closed closed:${s}..${e}", type: ISSUE, first: 1) { issueCount }`;
}

// GitHub search `label:` OR-list from configured names (default to the common
// bug variants when none set). Values with spaces/colons are quoted, escaped for
// the surrounding GraphQL string. Search is label-exact, so this is the closest
// approximation of the bug matcher for the cumulative stock counts.
function bugLabelSearch(configured: string[]): string {
	const labels = configured.length ? configured : ['bug', 'bugs', 'type: bug', 'type:bug', 'kind/bug'];
	return 'label:' + labels.map((l) => (/[\s:]/.test(l) ? `\\"${l}\\"` : l)).join(',');
}

function stockAliasBlock(owner: string, repo: string, m: Month, i: number, bugLabels: string): string {
	// Snapshot "as of" the month end, but never a future date: for the in-progress
	// month, clamp to today so open/stale counts aren't measured against the future.
	const today = new Date().toISOString().slice(0, 10);
	const end = monthEnd(m);
	const d = end > today ? today : end;
	const w = new Date(Date.parse(d) - 7 * DAY_MS).toISOString().slice(0, 10);
	const r = (q: string, alias: string) =>
		`${alias}_${i}: search(query: "repo:${owner}/${repo} ${q}", type: ISSUE, first: 1) { issueCount }`;
	return [
		r(`type:issue created:<=${d}`, 'i_open'),
		r(`type:issue closed:<=${d}`, 'i_closed'),
		r(`type:issue ${bugLabels} created:<=${d}`, 'b_open'),
		r(`type:issue ${bugLabels} closed:<=${d}`, 'b_closed'),
		r(`type:pr created:<=${d}`, 'p_open'),
		r(`type:pr closed:<=${d}`, 'p_closed'),
		r(`type:pr created:<=${w}`, 's_open'),
		r(`type:pr created:<=${w} closed:<=${d}`, 's_closed')
	].join('\n');
}

async function fetchRepoSeries(
	gql: GraphQL,
	{ owner, repo }: Repo,
	months: Month[],
	bugLabels: string[] = []
): Promise<RepoMonth[]> {
	const isBug = makeBugMatcher(bugLabels);
	const bugSearch = bugLabelSearch(bugLabels);
	const prBlocks = months.map((m, i) => prAliasBlock(owner, repo, m, i));
	const issueBlocks = months.map((m, i) => issueAliasBlock(owner, repo, m, i));
	// Stock aliases are first:1 (cheap); 8 per month is fine in larger chunks.
	const stockBlocks = months.map((m, i) => stockAliasBlock(owner, repo, m, i, bugSearch));

	const [prData, issueData, stockData, releaseCounts] = await Promise.all([
		runChunkedAliases(gql, prBlocks),
		runChunkedAliases(gql, issueBlocks),
		runChunkedAliases(gql, stockBlocks, 6),
		fetchReleases(gql, owner, repo, months)
	]);

	// GitHub can return a 200 with partial data (a per-field resource limit or an
	// inaccessible repo nulls individual aliases); default missing aliases to empty
	// so one bad field doesn't 500 the whole report.
	const emptySearch = { issueCount: 0, nodes: [] };
	return Promise.all(
		months.map(async (m, i) => {
		const count = (alias: string) => stockData[alias]?.issueCount ?? 0;
		// Drain past 100 nodes for high-volume months so sums/medians/bug counts
		// reflect every PR/issue, not just the first page.
		const mergedRaw = prData[`merged_${i}`] ?? emptySearch;
		const mergedNodes = mergedRaw.pageInfo?.hasNextPage
			? await drainSearchNodes(gql, mergedVolumeQuery(owner, repo, m), MERGED_VOLUME_FIELDS, mergedRaw)
			: (mergedRaw.nodes ?? []);
		const openedRaw = issueData[`opened_${i}`] ?? emptySearch;
		const openedNodes = openedRaw.pageInfo?.hasNextPage
			? await drainSearchNodes(gql, openedIssueQuery(owner, repo, m), ISSUE_NODE_FIELDS, openedRaw)
			: (openedRaw.nodes ?? []);
		const pr = prStatsForMonth({ issueCount: mergedRaw.issueCount ?? 0, nodes: mergedNodes }, prData[`created_${i}`]?.issueCount ?? 0, prData[`closed_${i}`]?.issueCount ?? 0);
		const iss = issueStatsForMonth({ issueCount: openedRaw.issueCount ?? 0, nodes: openedNodes }, issueData[`closed_${i}`]?.issueCount ?? 0, isBug);
		const issuesOpen = Math.max(0, count(`i_open_${i}`) - count(`i_closed_${i}`));
		const bugsOpen = Math.max(0, count(`b_open_${i}`) - count(`b_closed_${i}`));
		const prsOpen = Math.max(0, count(`p_open_${i}`) - count(`p_closed_${i}`));
		const prsStale = Math.max(0, count(`s_open_${i}`) - count(`s_closed_${i}`));
		return {
			owner,
			repo,
			month: monthKey(m),
			...pr,
			bugs: iss.bugs,
			issues: iss.opened,
			issuesOpen,
			bugsOpen,
			prsOpen,
			prsStale,
			releases: releaseCounts[i],
			resolutionDays: iss.resolutionDays,
			resolutionStd: iss.resolutionStd,
			resolutionRate: iss.resolutionRate
		};
		})
	);
}

async function fetchReleases(gql: GraphQL, owner: string, repo: string, months: Month[]): Promise<number[]> {
	const counts = months.map(() => 0);
	if (!months.length) return counts;
	// Releases are newest-first; page until we pass the start of the window so a
	// repo with >100 recent releases doesn't truncate older requested months.
	const windowStartMs = monthStartMs(months[0]);
	let cursor: string | null = null;
	for (let page = 0; page < 10; page++) {
		const data = await gql(`{
      repository(owner: "${owner}", name: "${repo}") {
        releases(first: 100, after: ${cursor ? `"${cursor}"` : 'null'}, orderBy: { field: CREATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes { publishedAt isDraft isPrerelease }
        }
      }
    }`);
		const conn = (data.repository as any)?.releases;
		if (!conn) break;
		let oldestMs = Infinity;
		for (const rel of conn.nodes) {
			if (rel.isDraft || rel.isPrerelease || !rel.publishedAt) continue;
			const t = Date.parse(rel.publishedAt);
			oldestMs = Math.min(oldestMs, t);
			const d = new Date(rel.publishedAt);
			const idx = months.findIndex((m) => m.year === d.getUTCFullYear() && m.month === d.getUTCMonth() + 1);
			if (idx >= 0) counts[idx] += 1;
		}
		if (!conn.pageInfo.hasNextPage || oldestMs < windowStartMs) break;
		cursor = conn.pageInfo.endCursor;
	}
	return counts;
}

/** Per-reviewer reviews/comments made (excludes self + PENDING + out-of-window),
 * for EVERY reviewer — the store keeps all of them so any team's "Others" bucket
 * can be reconstructed later. */
export function reviewCountsFromNodes(
	prs: ReviewPrNode[],
	startMs: number,
	endMs: number
): Map<string, { reviews: number; comments: number }> {
	const counts = new Map<string, { reviews: number; comments: number }>();
	const bump = (login: string, key: 'reviews' | 'comments') => {
		const e = counts.get(login) ?? { reviews: 0, comments: 0 };
		e[key] += 1;
		counts.set(login, e);
	};
	for (const pr of prs) {
		if (!pr) continue; // partial 200s can null individual search nodes
		const prAuthor = pr.author?.login ?? null;
		for (const review of pr.reviews?.nodes ?? []) {
			const reviewer = review.author?.login ?? null;
			if (!reviewer || reviewer === prAuthor || review.state === 'PENDING' || !review.submittedAt) continue;
			const t = Date.parse(review.submittedAt);
			if (t >= startMs && t <= endMs) bump(reviewer, 'reviews');
		}
		for (const comment of pr.comments?.nodes ?? []) {
			const commenter = comment.author?.login ?? null;
			if (!commenter || commenter === prAuthor) continue;
			const t = Date.parse(comment.createdAt);
			if (t >= startMs && t <= endMs) bump(commenter, 'comments');
		}
	}
	return counts;
}

async function fetchCommitData(gql: GraphQL, repos: Repo[], m: Month): Promise<Record<string, any>> {
	const s = monthStart(m);
	const e = monthEnd(m);
	const blocks = repos.flatMap(({ owner, repo }, i) => [
		`pr${i}: search(query: "repo:${owner}/${repo} type:pr updated:${s}..${e}", type: ISSUE, first: 100) {
      nodes { ... on PullRequest { commits(first: 100) { nodes { commit { oid committedDate author { email user { login } } } } } } }
    }`,
		`main${i}: repository(owner: "${owner}", name: "${repo}") {
      defaultBranchRef { target { ... on Commit { history(first: 100, since: "${s}T00:00:00Z", until: "${e}T23:59:59.999Z") {
        nodes { oid committedDate author { email user { login } } }
        pageInfo { hasNextPage endCursor }
      } } } }
    }`
	]);
	// Each block is a heavy nested query; keep chunks small.
	return runChunkedAliases(gql, blocks, 2);
}

type HistoryPage = { nodes: CommitNode[]; cursor: string | null };

/** One page of default-branch history after a cursor (used to drain repos whose
 * month has more than 100 default-branch commits, which the batched query caps). */
async function fetchHistoryPage(
	gql: GraphQL,
	owner: string,
	repo: string,
	s: string,
	e: string,
	after: string
): Promise<HistoryPage> {
	const data = await gql(`{
    repository(owner: "${owner}", name: "${repo}") {
      defaultBranchRef { target { ... on Commit { history(first: 100, after: "${after}", since: "${s}T00:00:00Z", until: "${e}T23:59:59.999Z") {
        nodes { oid committedDate author { email user { login } } }
        pageInfo { hasNextPage endCursor }
      } } } }
    }
  }`);
	const h = (data.repository as any)?.defaultBranchRef?.target?.history;
	return { nodes: h?.nodes ?? [], cursor: h?.pageInfo?.hasNextPage ? h.pageInfo.endCursor : null };
}

// ---------------------------------------------------------------------------
// Per-entity row fetchers (live). These fetch ONLY the months asked for, so the
// orchestrator can call them for just the months missing from the store.
// ---------------------------------------------------------------------------

/** Repo-month rows for the given repos + months (parallel per repo). */
export async function fetchRepoMonthRows(
	gql: GraphQL,
	repos: Repo[],
	months: Month[],
	bugLabels: string[] = []
): Promise<RepoMonth[]> {
	if (!months.length) return [];
	const all = await Promise.all(repos.map((r) => fetchRepoSeries(gql, r, months, bugLabels)));
	return all.flat();
}

/** Commits + merged-PRs per (member, repo, month). Only non-empty rows are returned. */
export async function fetchMemberRepoMonthRows(
	gql: GraphQL,
	repos: Repo[],
	members: Member[],
	months: Month[]
): Promise<MemberRepoMonthRow[]> {
	if (!months.length || !members.length || !repos.length) return [];
	const acc = new Map<string, MemberRepoMonthRow>(); // `${login}::${owner}/${repo}::${month}`
	const row = (login: string, owner: string, repo: string, month: string) => {
		const k = `${login}::${owner}/${repo}::${month}`;
		let r = acc.get(k);
		if (!r) {
			r = { login, owner, repo, month, commits: 0, mergedPrs: 0, additions: 0, deletions: 0 };
			acc.set(k, r);
		}
		return r;
	};

	// Member lookup maps (built once) so commit attribution is a single O(commits)
	// pass per repo/month instead of O(members x commits) re-scans.
	const byLogin = new Map(members.map((mm) => [mm.login.toLowerCase(), mm.login]));
	// Email is the fallback when a commit has no linked GitHub user. Drop any email
	// claimed by more than one member (shared/misconfigured address), otherwise it
	// would mis-attribute every commit authored under it to one arbitrary member.
	const emailOwners = new Map<string, Set<string>>();
	for (const mm of members) {
		if (!mm.email) continue;
		const k = mm.email.toLowerCase();
		(emailOwners.get(k) ?? emailOwners.set(k, new Set()).get(k)!).add(mm.login);
	}
	const byEmail = new Map(
		[...emailOwners].filter(([, owners]) => owners.size === 1).map(([k, owners]) => [k, [...owners][0]])
	);
	const matchedMember = (author: CommitNode['author']): string | null =>
		pickCommitMember(author, byLogin, byEmail);

	// Commits: fetch every month in parallel (bounded by the GraphQL semaphore),
	// then attribute each unique SHA to the matching member(s) in one pass.
	const commitWork = Promise.all(
		months.map(async (m) => {
			const month = monthKey(m);
			const startMs = monthStartMs(m);
			const endMs = monthEndMs(m);
			const commitData = await fetchCommitData(gql, repos, m);
			await Promise.all(
				repos.map(async ({ owner, repo }, i) => {
					const prCommits: CommitNode[] = (commitData[`pr${i}`]?.nodes ?? []).flatMap(
						(pr: any) => (pr?.commits?.nodes ?? []).map((c: any) => c.commit)
					);
					const history = commitData[`main${i}`]?.defaultBranchRef?.target?.history;
					const mainCommits: CommitNode[] = [...(history?.nodes ?? [])];
					// Drain repos with >100 default-branch commits this month (the batched
					// query only returns the first page) so commit counts aren't truncated.
					// Guarded so a stuck/repeating cursor can't loop unbounded.
					let cursor: string | null = history?.pageInfo?.hasNextPage ? history.pageInfo.endCursor : null;
					for (let guard = 0; cursor && guard < 50; guard++) {
						const page = await fetchHistoryPage(gql, owner, repo, monthStart(m), monthEnd(m), cursor);
						mainCommits.push(...page.nodes);
						cursor = page.cursor;
					}
					const shas = new Map<string, Set<string>>(); // member login -> unique SHAs
					const add = (login: string, oid: string) => {
						let s = shas.get(login);
						if (!s) shas.set(login, (s = new Set()));
						s.add(oid);
					};
					for (const c of prCommits) {
						const t = Date.parse(c.committedDate);
						if (t < startMs || t > endMs) continue;
						const login = matchedMember(c.author);
						if (login) add(login, c.oid);
					}
					for (const c of mainCommits) {
						const login = matchedMember(c.author);
						if (login) add(login, c.oid);
					}
					for (const [login, set] of shas) row(login, owner, repo, month).commits += set.size;
				})
			);
		})
	);

	// Merged PRs by author, per repo, all repos in parallel.
	const mergedWork = Promise.all(
		repos.map(async ({ owner, repo }) => {
			const mergedQuery = (m: Month) =>
				`repo:${owner}/${repo} type:pr is:merged merged:${monthStart(m)}..${monthEnd(m)}`;
			const blocks = months.map(
				(m, i) => `m_${i}: search(query: "${mergedQuery(m)}", type: ISSUE, first: 100) {
        nodes { ${MERGED_PR_NODE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }`
			);
			const data = await runChunkedAliases(gql, blocks);
			await Promise.all(
				months.map(async (m, i) => {
					const raw = data[`m_${i}`];
					const nodes = raw?.pageInfo?.hasNextPage
						? await drainSearchNodes(gql, mergedQuery(m), MERGED_PR_NODE_FIELDS, raw)
						: (raw?.nodes ?? []);
					for (const pr of nodes) {
						const canon = pr.author?.login && byLogin.get(pr.author.login.toLowerCase());
						if (canon) {
							const r = row(canon, owner, repo, monthKey(m));
							r.mergedPrs += 1;
							r.additions += pr.additions ?? 0;
							r.deletions += pr.deletions ?? 0;
						}
					}
				})
			);
		})
	);

	await Promise.all([commitWork, mergedWork]);
	return [...acc.values()].filter((r) => r.commits > 0 || r.mergedPrs > 0);
}

/** Reviews/comments per (reviewer, repo, month) for every reviewer. */
export async function fetchReviewRepoMonthRows(gql: GraphQL, repos: Repo[], months: Month[]): Promise<ReviewRepoMonthRow[]> {
	if (!months.length || !repos.length) return [];
	const out: ReviewRepoMonthRow[] = [];
	await Promise.all(
		months.map(async (m) => {
			const month = monthKey(m);
			const startMs = monthStartMs(m);
			const endMs = monthEndMs(m);
			const reviewQuery = (owner: string, repo: string) =>
				`repo:${owner}/${repo} type:pr updated:${monthStart(m)}..${monthEnd(m)}`;
			const blocks = repos.map(
				({ owner, repo }, i) => `
      r${i}: search(query: "${reviewQuery(owner, repo)}", type: ISSUE, first: 100) {
        nodes { ${REVIEW_PR_NODE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }`
			);
			const data = await runChunkedAliases(gql, blocks);
			await Promise.all(
				repos.map(async ({ owner, repo }, i) => {
					const raw = data[`r${i}`];
					// Drain >100 updated PRs/month so reviewer/comment counts aren't truncated.
					const nodes = raw?.pageInfo?.hasNextPage
						? await drainSearchNodes(gql, reviewQuery(owner, repo), REVIEW_PR_NODE_FIELDS, raw)
						: (raw?.nodes ?? []);
					const counts = reviewCountsFromNodes(nodes, startMs, endMs);
					for (const [reviewer, v] of counts) out.push({ reviewer, owner, repo, month, reviews: v.reviews, comments: v.comments });
				})
			);
		})
	);
	return out;
}

/** Currently-open PRs across the given repos (live, current state). Oldest first
 * so a per-repo cap keeps the most-stuck ones. */
export async function fetchOpenPullRequests(gql: GraphQL, repos: Repo[]): Promise<OpenPr[]> {
	if (!repos.length) return [];
	const blocks = repos.map(
		({ owner, repo }, i) => `
      op_${i}: search(query: "repo:${owner}/${repo} type:pr is:open sort:created-asc", type: ISSUE, first: 100) {
        nodes { ... on PullRequest {
          number title url isDraft createdAt updatedAt
          author { login __typename }
          reviewDecision
          additions deletions
          comments { totalCount }
          reviews { totalCount }
        } }
      }`
	);
	const data = await runChunkedAliases(gql, blocks);
	const out: OpenPr[] = [];
	repos.forEach(({ owner, repo }, i) => {
		for (const pr of data[`op_${i}`]?.nodes ?? []) {
			if (!pr || typeof pr.number !== 'number') continue;
			out.push({
				repo: `${owner}/${repo}`,
				number: pr.number,
				title: pr.title ?? '',
				url: pr.url ?? '',
				author: pr.author?.login ?? 'unknown',
				bot: pr.author?.__typename === 'Bot',
				draft: !!pr.isDraft,
				createdAt: pr.createdAt,
				updatedAt: pr.updatedAt,
				reviewDecision: pr.reviewDecision ?? null,
				reviews: pr.reviews?.totalCount ?? 0,
				comments: pr.comments?.totalCount ?? 0,
				additions: pr.additions ?? 0,
				deletions: pr.deletions ?? 0
			});
		}
	});
	return out;
}

/** Merged PRs in the window with their review timeline, for cycle-time + review
 * health. One PrFlow per merged PR. */
export async function fetchPrFlow(
	gql: GraphQL,
	repos: Repo[],
	months: Month[]
): Promise<{ prs: PrFlow[]; botActivity: BotActivity[]; botByMonth: BotMonthActivity[] }> {
	if (!months.length || !repos.length) return { prs: [], botActivity: [], botByMonth: [] };
	const out: PrFlow[] = [];
	const botAcc = new Map<string, BotActivity>(); // bot login -> window total
	const botMonth = new Map<string, Map<string, { reviews: number; comments: number }>>(); // month -> login -> counts
	await Promise.all(
		months.map(async (m) => {
			const month = monthKey(m);
			const s = monthStart(m);
			const e = monthEnd(m);
			const mergedFlowQuery = (owner: string, repo: string) =>
				`repo:${owner}/${repo} type:pr is:merged merged:${s}..${e}`;
			const blocks = repos.map(
				({ owner, repo }, i) => `
      f${i}: search(query: "${mergedFlowQuery(owner, repo)}", type: ISSUE, first: 100) {
        nodes { ${FLOW_PR_NODE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }`
			);
			const data = await runChunkedAliases(gql, blocks, 2);
			await Promise.all(
				repos.map(async ({ owner, repo }, i) => {
				const raw = data[`f${i}`];
				// Drain >100 merged PRs/month so flow medians and bot counts are complete.
				const nodes = raw?.pageInfo?.hasNextPage
					? await drainSearchNodes(gql, mergedFlowQuery(owner, repo), FLOW_PR_NODE_FIELDS, raw)
					: (raw?.nodes ?? []);
				for (const pr of nodes) {
					if (!pr?.createdAt || !pr?.mergedAt) continue;
					const submitted: any[] = (pr.reviews?.nodes ?? []).filter(
						(r: any) => r?.submittedAt && r.author?.login
					);
					// Bot reviewers (CodeRabbit, CodeScene, Copilot, ...) are excluded from
					// human latency stats but tallied here for the Bots page. `comments`
					// is the inline review-comment volume; `prs` counts each PR once per
					// bot so the page can show comments-per-PR.
					const botsOnPr = new Set<string>();
					let mm = botMonth.get(month);
					if (!mm) botMonth.set(month, (mm = new Map()));
					for (const r of submitted) {
						if (r.author.__typename !== 'Bot') continue;
						const b = botAcc.get(r.author.login) ?? { login: r.author.login, reviews: 0, comments: 0, prs: 0 };
						const verdict = r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED';
						const comments = r.comments?.totalCount ?? 0;
						if (verdict) b.reviews += 1;
						b.comments += comments;
						botAcc.set(r.author.login, b);
						const bm = mm.get(r.author.login) ?? { reviews: 0, comments: 0 };
						if (verdict) bm.reviews += 1;
						bm.comments += comments;
						mm.set(r.author.login, bm);
						botsOnPr.add(r.author.login);
					}
					for (const login of botsOnPr) botAcc.get(login)!.prs += 1;
					// Human reviews only: bots review instantly and would skew latency.
					const reviewNodes: any[] = submitted.filter((r: any) => r.author?.__typename !== 'Bot');
					const times = reviewNodes.map((r) => r.submittedAt).sort();
					// Gating approval = the LAST approval at/before merge, not the first:
					// an early approve followed by more changes and a re-approve must keep
					// the rework inside review time, not the post-approval wait.
					const mergedMs = Date.parse(pr.mergedAt);
					const approvals = reviewNodes
						.filter((r) => r.state === 'APPROVED' && Date.parse(r.submittedAt) <= mergedMs)
						.map((r) => r.submittedAt)
						.sort();
					const reviewers = [...new Set(reviewNodes.map((r) => r.author?.login).filter(Boolean))] as string[];
					out.push({
						repo: `${owner}/${repo}`,
						month,
						createdAt: pr.createdAt,
						mergedAt: pr.mergedAt,
						firstReviewAt: times[0] ?? null,
						approvedAt: approvals[approvals.length - 1] ?? null,
						reviewers
					});
				}
				})
			);
		})
	);
	const botActivity = [...botAcc.values()].sort(
		(a, b) => b.reviews + b.comments - (a.reviews + a.comments)
	);
	const botByMonth: BotMonthActivity[] = [];
	for (const [month, mm] of botMonth)
		for (const [login, c] of mm) botByMonth.push({ month, login, reviews: c.reviews, comments: c.comments });
	return { prs: out, botActivity, botByMonth };
}
