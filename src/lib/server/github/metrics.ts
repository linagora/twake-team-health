import { type GraphQL } from './client';
import { median, round, makeBugMatcher, type BugSignal } from './stats';
import { type Month, monthKey, monthStart, monthEnd, monthStartMs, monthEndMs } from './months';
import type {
	Repo,
	RepoMonth,
	OpenPr,
	PrFlow,
	BotActivity,
	BotMonthActivity,
	PrFact,
	IssueFact,
	CommitFact,
	ReviewFact,
	ReleaseFact,
	StockDay,
} from './types';

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
	closedCount: number,
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
		reviewsPerPr: total > 0 ? round(median(reviews), 2) : 0,
	};
}

type IssueNode = {
	createdAt: string;
	closedAt: string | null;
	labels: { nodes: { name: string }[] };
	issueType?: string | null;
};

export function issueStatsForMonth(
	opened: { issueCount: number; nodes: IssueNode[] },
	closedCount: number,
	isBug: (s: BugSignal) => boolean = makeBugMatcher(),
): {
	opened: number;
	closed: number;
	bugs: number;
	resolutionDays: number;
	resolutionRate: number;
} {
	let bugs = 0;
	const resolutionDaysList: number[] = [];
	for (const issue of opened.nodes) {
		if (!issue) continue; // partial 200s can null individual search nodes
		const labels = issue.labels?.nodes?.map((l) => l.name) ?? [];
		if (isBug({ labels, issueType: issue.issueType ?? null })) {
			bugs += 1;
			if (issue.closedAt) {
				resolutionDaysList.push(
					round((Date.parse(issue.closedAt) - Date.parse(issue.createdAt)) / DAY_MS, 2),
				);
			}
		}
	}
	return {
		opened: opened.issueCount,
		closed: closedCount,
		bugs,
		resolutionDays: resolutionDaysList.length ? round(median(resolutionDaysList), 2) : 0,
		resolutionRate: bugs > 0 ? round((resolutionDaysList.length / bugs) * 100, 1) : 0,
	};
}

type CommitNode = {
	oid: string;
	committedDate: string;
	author: { email: string | null; user: { login: string } | null };
};

// --- Burnout / recovery: when (in the committer's LOCAL time) was a commit made ---
// We need the committer's local wall clock. Sources, in priority order:
//   1. An explicit IANA timezone configured for the member (DST-correct via Intl).
//      This is necessary because many commits are stamped in UTC (CI, squash-merges,
//      UTC-configured machines), so the embedded offset alone misreads, e.g., a Hanoi
//      team's mornings as "late night".
//   2. The UTC offset embedded in `committedDate` (a correctly-configured machine).
//   3. Plain UTC when neither is available.

const WEEKDAY_NUM: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

// Constructing an Intl.DateTimeFormat is the expensive part of timezone formatting,
// so cache one per zone: the per-commit classification runs over thousands of commits
// and would otherwise rebuild the same formatter every time.
const tzFormatters = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(tz: string): Intl.DateTimeFormat {
	let f = tzFormatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone: tz, // throws for an unknown zone (caught by the caller)
			weekday: 'short',
			hour12: false,
			hour: '2-digit',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		});
		tzFormatters.set(tz, f);
	}
	return f;
}

/** Local weekday (0=Sun..6=Sat), hour (0-23), and integer local-day number for a
 * commit instant — in `tz` (IANA) when given, else from the timestamp's own offset
 * (a zone-less timestamp is pinned to UTC so the result is never server-dependent). */
function localParts(
	iso: string,
	tz?: string,
): { dow: number; hour: number; dayNum: number } | null {
	const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
	const hasZone = !!m || /[zZ]$/.test(iso);
	const ms = Date.parse(hasZone ? iso : `${iso}Z`);
	if (Number.isNaN(ms)) return null;
	if (tz) {
		try {
			const parts = tzFormatter(tz).formatToParts(new Date(ms));
			const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
			const dow = WEEKDAY_NUM[get('weekday')];
			const hour = Number(get('hour')) % 24; // some engines render midnight as "24"
			if (dow === undefined || Number.isNaN(hour)) return null;
			const dayNum = Math.floor(
				Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))) / DAY_MS,
			);
			return { dow, hour, dayNum };
		} catch {
			// Invalid/unknown tz: fall through to the embedded-offset path.
		}
	}
	const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
	const localMs = ms + offsetMin * 60_000;
	const d = new Date(localMs);
	return {
		dow: d.getUTCDay(),
		hour: d.getUTCHours(),
		dayNum: Math.floor(localMs / DAY_MS),
	};
}

/** Local weekday + hour for a commit, in the member's timezone when known. */
export function commitLocalTime(iso: string, tz?: string): { dow: number; hour: number } | null {
	const p = localParts(iso, tz);
	return p ? { dow: p.dow, hour: p.hour } : null;
}

/** Monday-aligned 7-day bucket id for recovery (time-off) detection. Buckets MUST
 * align to the work week (epoch 1970-01-01 is a Thursday; 1970-01-05 (Mon) is day 4),
 * so one Mon-Sun calendar week maps to exactly one bucket and a full week off leaves
 * a gap that resets the streak. Computed in the member's local time when `tz` is set. */
export function weekIdOf(iso: string, tz?: string): number | null {
	const p = localParts(iso, tz);
	return p ? Math.floor((p.dayNum - 4) / 7) : null;
}

/** Classify a commit's local timestamp into the two burnout buckets: committed on a
 * weekend (Sat/Sun), and/or in the late-night window (22:00-05:59), in `tz` if known. */
export function classifyCommitTime(
	iso: string,
	tz?: string,
): { weekend: boolean; lateNight: boolean } {
	const p = localParts(iso, tz);
	if (!p) return { weekend: false, lateNight: false };
	return {
		weekend: p.dow === 0 || p.dow === 6,
		lateNight: p.hour >= 22 || p.hour < 6,
	};
}

/** Attribute a commit to exactly one member: a linked GitHub login wins, then a
 * (non-shared) author email, else nobody. One member per commit avoids the
 * double-count where login and email point at different people. */
export function pickCommitMember(
	author: CommitNode['author'] | null,
	byLogin: Map<string, string>,
	byEmail: Map<string, string>,
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
	perQuery = ALIASES_PER_QUERY,
): Promise<Record<string, any>> {
	const merged: Record<string, any> = {};
	for (const group of chunk(aliasBlocks, perQuery)) {
		const data = await gql('{\n' + group.join('\n') + '\n}');
		Object.assign(merged, data);
	}
	return merged;
}

// Node selections shared by the alias block and the pagination drainer so both
// request identical fields. Fact fetchers pull the full node once and store it
// raw; all classification (bug labels, member attribution, windows) happens at
// read time in the aggregator.
const PR_FACT_FIELDS = `... on PullRequest { number author { login } createdAt mergedAt closedAt additions deletions comments { totalCount } reviews { totalCount } }`;
const ISSUE_FACT_FIELDS = `... on Issue { number createdAt closedAt labels(first: 10) { nodes { name } } issueType { name } }`;
const REVIEW_FACT_PR_FIELDS = `... on PullRequest { number author { login } reviews(first: 100) { nodes { id author { login __typename avatarUrl } submittedAt state comments { totalCount } } } comments(first: 100) { nodes { id author { login __typename avatarUrl } createdAt } } }`;
const FLOW_PR_NODE_FIELDS = `... on PullRequest { createdAt mergedAt reviews(first: 100) { nodes { submittedAt state author { login __typename avatarUrl } comments { totalCount } } } }`;

/** Inclusive day range, "YYYY-MM-DD". Callers slice long spans into
 * calendar-month ranges so no single search can hit GitHub's 1000-result cap. */
export type DayRange = { s: string; e: string };

type Page<T> = {
	nodes?: T[];
	pageInfo?: { hasNextPage?: boolean; endCursor?: string };
};

/** Drain a Relay-style cursor connection past its first page. `fetchPage(after)`
 * returns the next page's nodes and the cursor to continue (null when done).
 * Capped so a stuck/repeating cursor can never loop unbounded. */
async function drainConnection<T>(
	first: Page<T>,
	fetchPage: (after: string) => Promise<{ nodes: T[]; cursor: string | null }>,
	maxPages = 20,
): Promise<T[]> {
	const nodes = [...(first.nodes ?? [])];
	let cursor = first.pageInfo?.hasNextPage ? (first.pageInfo.endCursor ?? null) : null;
	for (let page = 0; cursor && page < maxPages; page++) {
		const next = await fetchPage(cursor);
		nodes.push(...next.nodes);
		cursor = next.cursor;
	}
	return nodes;
}

/** Collect every node of a search, draining past the first 100 (GitHub Search
 * caps the total result set at 1000). `first` is the already-fetched first page. */
async function drainSearchNodes(
	gql: GraphQL,
	query: string,
	fields: string,
	first: Page<any>,
): Promise<any[]> {
	return drainConnection(first, async (after) => {
		const data: any = await gql(
			`{ search(query: ${JSON.stringify(query)}, type: ISSUE, first: 100, after: "${after}") {
        nodes { ${fields} } pageInfo { hasNextPage endCursor }
      } }`,
		);
		const sr = data.search;
		return {
			nodes: sr?.nodes ?? [],
			cursor: sr?.pageInfo?.hasNextPage ? (sr.pageInfo.endCursor ?? null) : null,
		};
	});
}

/** Search + drain every node for `query` (first page fetched here too). */
async function searchAllNodes(gql: GraphQL, query: string, fields: string): Promise<any[]> {
	const data: any = await gql(
		`{ search(query: ${JSON.stringify(query)}, type: ISSUE, first: 100) {
      nodes { ${fields} } pageInfo { hasNextPage endCursor }
    } }`,
	);
	const first = data.search ?? {};
	return first.pageInfo?.hasNextPage
		? drainSearchNodes(gql, query, fields, first)
		: (first.nodes ?? []);
}

// GitHub search `label:` OR-list from configured names (default to the common
// bug variants when none set). Values with spaces/colons are quoted, escaped for
// the surrounding GraphQL string. Search is label-exact, so this is the closest
// approximation of the bug matcher for the cumulative stock counts.
// LIMITATION: GitHub issue search cannot filter on native issue types, so the
// open-bug STOCK (bugsOpen) stays label-based. A team that types issues but does
// not label them will see the per-window "bugs raised" flow reflect reality while
// bugsOpen under-counts. Accepted: deriving stock from stored facts is out of scope.
function bugLabelSearch(configured: string[]): string {
	const labels = configured.length
		? configured
		: ['bug', 'bugs', 'type: bug', 'type:bug', 'kind/bug'];
	return 'label:' + labels.map((l) => (/[\s:]/.test(l) ? `\\"${l}\\"` : l)).join(',');
}

function stockAliasBlock(
	owner: string,
	repo: string,
	d: string,
	i: number,
	bugLabels: string,
): string {
	const r = (q: string, alias: string) =>
		`${alias}_${i}: search(query: "repo:${owner}/${repo} ${q}", type: ISSUE, first: 1) { issueCount }`;
	return [
		r(`type:issue created:<=${d}`, 'i_open'),
		r(`type:issue closed:<=${d}`, 'i_closed'),
		r(`type:issue ${bugLabels} created:<=${d}`, 'b_open'),
		r(`type:issue ${bugLabels} closed:<=${d}`, 'b_closed'),
		r(`type:pr created:<=${d}`, 'p_open'),
		r(`type:pr closed:<=${d}`, 'p_closed'),
	].join('\n');
}

/** Open-stock snapshot (open issues / bugs / PRs) as-of `day` for one repo —
 * cumulative created-minus-closed counts, matching the legacy month-end rule.
 * Cheap: six first:1 count searches. Callers clamp `day` to today. */
export async function fetchStockAsOf(
	gql: GraphQL,
	{ owner, repo }: Repo,
	days: string[],
	bugLabels: string[] = [],
): Promise<StockDay[]> {
	if (!days.length) return [];
	const bugSearch = bugLabelSearch(bugLabels);
	const blocks = days.map((d, i) => stockAliasBlock(owner, repo, d, i, bugSearch));
	const data = await runChunkedAliases(gql, blocks, 6);
	return days.map((day, i) => {
		const count = (alias: string) => data[`${alias}_${i}`]?.issueCount ?? 0;
		return {
			owner,
			repo,
			day,
			issuesOpen: Math.max(0, count(`i_open`) - count(`i_closed`)),
			bugsOpen: Math.max(0, count(`b_open`) - count(`b_closed`)),
			prsOpen: Math.max(0, count(`p_open`) - count(`p_closed`)),
		};
	});
}

// ---------------------------------------------------------------------------
// Fact fetchers. Each pulls raw GitHub events for explicit day ranges and
// returns store-ready fact rows; nothing is classified or bucketed here. The
// created:.. AND closed:.. searches together guarantee every PR/issue relevant
// to a window is captured: an item created before the backfill horizon still
// appears (and gets its terminal timestamps) the moment it closes or merges.
// ---------------------------------------------------------------------------

const dateOrNull = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);

/** PR facts touched (created or closed/merged) in the given ranges of one repo. */
export async function fetchPrFactRows(
	gql: GraphQL,
	{ owner, repo }: Repo,
	ranges: DayRange[],
): Promise<PrFact[]> {
	const byNumber = new Map<number, PrFact>();
	// All (range x created/closed) searches in parallel: the GraphQL client's
	// semaphore bounds global concurrency, so serializing here only added latency.
	const queries = ranges.flatMap(({ s, e }) => [
		`repo:${owner}/${repo} type:pr created:${s}..${e}`,
		`repo:${owner}/${repo} type:pr is:closed closed:${s}..${e}`,
	]);
	const pages = await Promise.all(queries.map((q) => searchAllNodes(gql, q, PR_FACT_FIELDS)));
	{
		for (const pr of pages.flat()) {
			{
				if (!pr || typeof pr.number !== 'number' || !pr.createdAt) continue;
				byNumber.set(pr.number, {
					owner,
					repo,
					number: pr.number,
					author: pr.author?.login ?? null,
					createdAt: new Date(pr.createdAt),
					mergedAt: dateOrNull(pr.mergedAt),
					closedAt: dateOrNull(pr.closedAt),
					additions: pr.additions ?? 0,
					deletions: pr.deletions ?? 0,
					comments: pr.comments?.totalCount ?? 0,
					reviews: pr.reviews?.totalCount ?? 0,
				});
			}
		}
	}
	return [...byNumber.values()];
}

/** Issue facts touched (created or closed) in the given ranges of one repo.
 * `reconcile` adds an `updated:`-keyed pass: an issue created earlier but
 * relabeled/retyped after first ingest is missed by the created/closed windows,
 * so re-pull anything UPDATED since `updatedSince` (bounded to the reporting span
 * by `createdFrom`), reconciling stored labels/type for older in-window issues. */
export async function fetchIssueFactRows(
	gql: GraphQL,
	{ owner, repo }: Repo,
	ranges: DayRange[],
	reconcile?: { updatedSince: string; createdFrom: string },
): Promise<IssueFact[]> {
	const byNumber = new Map<number, IssueFact>();
	const queries = ranges.flatMap(({ s, e }) => [
		`repo:${owner}/${repo} type:issue created:${s}..${e}`,
		`repo:${owner}/${repo} type:issue is:closed closed:${s}..${e}`,
	]);
	if (reconcile) {
		queries.push(
			`repo:${owner}/${repo} type:issue created:>=${reconcile.createdFrom} updated:>=${reconcile.updatedSince}`,
		);
	}
	const pages = await Promise.all(queries.map((q) => searchAllNodes(gql, q, ISSUE_FACT_FIELDS)));
	{
		for (const issue of pages.flat()) {
			{
				if (!issue || typeof issue.number !== 'number' || !issue.createdAt) continue;
				byNumber.set(issue.number, {
					owner,
					repo,
					number: issue.number,
					createdAt: new Date(issue.createdAt),
					closedAt: dateOrNull(issue.closedAt),
					labels: (issue.labels?.nodes ?? []).map((l: { name: string }) => l?.name).filter(Boolean),
					issueType: issue.issueType?.name ?? null,
				});
			}
		}
	}
	return [...byNumber.values()];
}

/** Review + review-comment facts from PRs UPDATED in the given ranges. Any new
 * review activity updates its PR, so refreshing the recently-updated set catches
 * every new event; the id-keyed upsert dedupes re-seen history. */
export async function fetchReviewFactRows(
	gql: GraphQL,
	{ owner, repo }: Repo,
	ranges: DayRange[],
): Promise<ReviewFact[]> {
	const byId = new Map<string, ReviewFact>();
	const pages = await Promise.all(
		ranges.map(({ s, e }) =>
			searchAllNodes(
				gql,
				`repo:${owner}/${repo} type:pr updated:${s}..${e}`,
				REVIEW_FACT_PR_FIELDS,
			),
		),
	);
	for (const pr of pages.flat()) {
		if (!pr || typeof pr.number !== 'number') continue;
		const prAuthor = pr.author?.login ?? null;
		for (const r of pr.reviews?.nodes ?? []) {
			// PENDING reviews have no submittedAt and are not activity yet.
			if (!r?.id || !r.author?.login || !r.submittedAt) continue;
			byId.set(r.id, {
				owner,
				repo,
				id: r.id,
				prNumber: pr.number,
				prAuthor,
				reviewer: r.author.login,
				kind: 'review',
				state: r.state ?? null,
				isBot: r.author.__typename === 'Bot',
				avatarUrl: r.author.avatarUrl ?? null,
				commentsCount: r.comments?.totalCount ?? 0,
				ts: new Date(r.submittedAt),
			});
		}
		for (const c of pr.comments?.nodes ?? []) {
			if (!c?.id || !c.author?.login || !c.createdAt) continue;
			byId.set(c.id, {
				owner,
				repo,
				id: c.id,
				prNumber: pr.number,
				prAuthor,
				reviewer: c.author.login,
				kind: 'comment',
				state: null,
				isBot: c.author.__typename === 'Bot',
				avatarUrl: c.author.avatarUrl ?? null,
				commentsCount: 0,
				ts: new Date(c.createdAt),
			});
		}
	}
	return [...byId.values()];
}

type HistoryPage = { nodes: CommitNode[]; cursor: string | null };

/** One page of default-branch history after a cursor (drains repos with more
 * than 100 commits in the fetched range). */
async function fetchHistoryPage(
	gql: GraphQL,
	owner: string,
	repo: string,
	{ s, e }: DayRange,
	after: string,
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
	return {
		nodes: h?.nodes ?? [],
		cursor: h?.pageInfo?.hasNextPage ? h.pageInfo.endCursor : null,
	};
}

/** Commit facts for one repo over one range: default-branch history plus commits
 * on PRs updated in the range (feature-branch work), deduped by SHA. Attribution
 * to members happens at read time, so facts are stored for every author. */
export async function fetchCommitFactRows(
	gql: GraphQL,
	{ owner, repo }: Repo,
	range: DayRange,
): Promise<CommitFact[]> {
	const { s, e } = range;
	const startMs = Date.parse(`${s}T00:00:00Z`);
	const endMs = Date.parse(`${e}T23:59:59.999Z`);
	const blocks = [
		`pr0: search(query: "repo:${owner}/${repo} type:pr updated:${s}..${e}", type: ISSUE, first: 100) {
      nodes { ... on PullRequest { commits(first: 100) { nodes { commit { oid committedDate author { email user { login } } } } } } }
    }`,
		`main0: repository(owner: "${owner}", name: "${repo}") {
      defaultBranchRef { target { ... on Commit { history(first: 100, since: "${s}T00:00:00Z", until: "${e}T23:59:59.999Z") {
        nodes { oid committedDate author { email user { login } } }
        pageInfo { hasNextPage endCursor }
      } } } }
    }`,
	];
	const data = await runChunkedAliases(gql, blocks, 2);
	const prCommits: CommitNode[] = (data.pr0?.nodes ?? []).flatMap((pr: any) =>
		(pr?.commits?.nodes ?? []).map((c: any) => c.commit),
	);
	const history = data.main0?.defaultBranchRef?.target?.history;
	const mainCommits = await drainConnection<CommitNode>(
		history ?? {},
		async (after) => fetchHistoryPage(gql, owner, repo, range, after),
		50,
	);
	const byOid = new Map<string, CommitFact>();
	for (const c of [...prCommits, ...mainCommits]) {
		if (!c?.oid || !c.committedDate) continue;
		const t = Date.parse(c.committedDate);
		// PR-associated commits can predate the range (old commits on a freshly
		// updated PR); keep only the range's own commits so refetches stay bounded.
		if (Number.isNaN(t) || t < startMs || t > endMs) continue;
		byOid.set(c.oid, {
			owner,
			repo,
			oid: c.oid,
			authorLogin: c.author?.user?.login ?? null,
			authorEmail: c.author?.email ?? null,
			committedDate: c.committedDate,
			committedAt: new Date(t),
		});
	}
	return [...byOid.values()];
}

/** Release facts for one repo, newest-first, paged back until `sinceDay`. */
export async function fetchReleaseFactRows(
	gql: GraphQL,
	{ owner, repo }: Repo,
	sinceDay: string,
): Promise<ReleaseFact[]> {
	const out: ReleaseFact[] = [];
	const sinceMs = Date.parse(`${sinceDay}T00:00:00Z`);
	let cursor: string | null = null;
	for (let page = 0; page < 10; page++) {
		const data = await gql(`{
      repository(owner: "${owner}", name: "${repo}") {
        releases(first: 100, after: ${cursor ? `"${cursor}"` : 'null'}, orderBy: { field: CREATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes { tagName publishedAt isDraft isPrerelease }
        }
      }
    }`);
		const conn = (data.repository as any)?.releases;
		if (!conn) break;
		let oldestMs = Infinity;
		for (const rel of conn.nodes ?? []) {
			if (!rel || rel.isDraft || rel.isPrerelease || !rel.publishedAt || !rel.tagName) continue;
			const t = Date.parse(rel.publishedAt);
			oldestMs = Math.min(oldestMs, t);
			if (t >= sinceMs) out.push({ owner, repo, tag: rel.tagName, publishedAt: new Date(t) });
		}
		if (!conn.pageInfo?.hasNextPage || oldestMs < sinceMs) break;
		cursor = conn.pageInfo.endCursor;
	}
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
      }`,
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
				deletions: pr.deletions ?? 0,
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
	months: Month[],
): Promise<{
	prs: PrFlow[];
	botActivity: BotActivity[];
	botByMonth: BotMonthActivity[];
}> {
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
      }`,
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
							(r: any) => r?.submittedAt && r.author?.login,
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
							const b = botAcc.get(r.author.login) ?? {
								login: r.author.login,
								avatarUrl: r.author.avatarUrl ?? '',
								reviews: 0,
								comments: 0,
								prs: 0,
							};
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
						const reviewers = [
							...new Set(reviewNodes.map((r) => r.author?.login).filter(Boolean)),
						] as string[];
						out.push({
							repo: `${owner}/${repo}`,
							month,
							createdAt: pr.createdAt,
							mergedAt: pr.mergedAt,
							firstReviewAt: times[0] ?? null,
							approvedAt: approvals[approvals.length - 1] ?? null,
							reviewers,
						});
					}
				}),
			);
		}),
	);
	const botActivity = [...botAcc.values()].sort(
		(a, b) => b.reviews + b.comments - (a.reviews + a.comments),
	);
	const botByMonth: BotMonthActivity[] = [];
	for (const [month, mm] of botMonth)
		for (const [login, c] of mm)
			botByMonth.push({
				month,
				login,
				reviews: c.reviews,
				comments: c.comments,
			});
	return { prs: out, botActivity, botByMonth };
}
