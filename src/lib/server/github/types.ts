export type Repo = {
	owner: string;
	repo: string;
	/** Exclude this repo's GitHub releases from the release stats (e.g. monorepos
	 * that publish a release per package). Omitted = releases counted normally. */
	noReleases?: boolean;
};
export type Member = {
	login: string;
	name: string;
	email?: string;
	tz?: string;
};

/** One repository's metrics for one month. Mirrors the old RepoMonth shape so the
 * existing chart transforms keep working, plus the derived stock/release/resolution. */
export type RepoMonth = {
	owner: string;
	repo: string;
	month: string; // YYYY-MM
	created: number;
	merged: number;
	closed: number;
	additions: number; // total additions across merged PRs in the month
	deletions: number; // total deletions across merged PRs in the month
	addPerPr: number;
	delPerPr: number;
	daysPerPr: number;
	commentsPerPr: number;
	reviewsPerPr: number;
	bugs: number;
	issues: number;
	issuesOpen: number;
	bugsOpen: number;
	prsOpen: number;
	releases: number;
	resolutionDays: number;
	resolutionRate: number;
};

export type AuthorMonth = { author: string; month: string; commits: number };
export type MergedAuthorMonth = {
	author: string;
	month: string;
	mergedPRs: number;
};
export type ReviewActivity = {
	author: string;
	reviews: number;
	comments: number;
};
export type IssueMonth = { month: string; tickets: number; bugs: number };
/** New metric: commits by a member, broken down per repository, over the window. */
export type AuthorRepoCommits = {
	author: string;
	repo: string;
	commits: number;
};
/** Lines added/removed by a member's merged PRs, over the window. */
export type AuthorLines = {
	author: string;
	additions: number;
	deletions: number;
};
/** When a member commits, over the window: total vs. the weekend / late-night
 * (local-time) shares that feed burnout detection. */
export type WorkPattern = {
	author: string;
	commits: number;
	weekendCommits: number;
	lateNightCommits: number;
	/** 7-day bucket ids this member committed in (sorted), for recovery detection. */
	activeWeeks: number[];
};

/** Headline counts over a rolling window (last N days). Same four measures the
 * overview hero shows, so it can read a full 30-day span instead of the
 * in-progress calendar month (which reads ~0 on the 1st). */
export type WindowCounts = {
	created: number;
	merged: number;
	bugs: number;
	issues: number;
};

/** The rolling-30d headline: the current window and the window before it (for
 * the trend). `computedAt` is when the underlying facts were aggregated. */
export type Window30d = {
	current: WindowCounts;
	previous: WindowCounts;
	computedAt: number | null;
};

/** One member's activity over the trailing 30 days, for leaderboards/KPIs that
 * must never collapse at a month boundary. */
export type RecentMember = {
	login: string;
	commits: number;
	mergedPrs: number;
	additions: number;
	deletions: number;
	reviews: number;
	comments: number;
	/** Distinct repos the member committed to in the window (breadth award). */
	repos: number;
};

/** One repository's activity over the current vs previous rolling window, so the
 * "most active repos" list is a trailing-30d view with a vs-previous delta. */
export type RecentRepo = {
	owner: string;
	repo: string;
	current: WindowCounts;
	previous: WindowCounts;
};

/** One day's headline counts (UTC), for the rolling sparklines that replace the
 * monthly-bucket sparklines beside the trailing-30d hero numbers. */
export type DailyCount = {
	day: string; // "YYYY-MM-DD"
	created: number;
	merged: number;
	bugs: number;
};

export type MetricsResult = {
	repos: RepoMonth[];
	authors: AuthorMonth[];
	mergedByAuthor: MergedAuthorMonth[];
	reviewActivity: ReviewActivity[];
	issuesByMonth: IssueMonth[];
	commitsByAuthorRepo: AuthorRepoCommits[];
	linesByAuthor: AuthorLines[];
	workPattern: WorkPattern[];
	/** Rolling last-30-days headline (aggregated from facts at read time). */
	window30d?: Window30d;
	/** Per-member trailing-30d activity for leaderboards. */
	recentMembers?: RecentMember[];
	/** Per-repo trailing-30d activity (current vs previous window). */
	recentRepos?: RecentRepo[];
	/** Daily headline counts over the trailing window, for rolling sparklines. */
	recentDaily?: DailyCount[];
	/** Per-member work pattern over the trailing 30d (weekend/late-night/active
	 * weeks), for the rolling burnout signal. */
	recentWorkPattern?: WorkPattern[];
	generatedAt: number;
};

// ---- Fact store rows (raw GitHub events; see db/schema.ts for rationale) ----
export type PrFact = {
	owner: string;
	repo: string;
	number: number;
	author: string | null;
	createdAt: Date;
	mergedAt: Date | null;
	closedAt: Date | null;
	additions: number;
	deletions: number;
	comments: number;
	reviews: number;
};

export type IssueFact = {
	owner: string;
	repo: string;
	number: number;
	createdAt: Date;
	closedAt: Date | null;
	labels: string[];
	// GitHub native issue type name (e.g. "Bug"); null when untyped/not-yet-fetched.
	issueType: string | null;
};

export type CommitFact = {
	owner: string;
	repo: string;
	oid: string;
	authorLogin: string | null;
	authorEmail: string | null;
	committedDate: string; // raw ISO, offset preserved for local-time classification
	committedAt: Date;
};

export type ReviewFact = {
	owner: string;
	repo: string;
	id: string;
	prNumber: number;
	prAuthor: string | null;
	reviewer: string;
	kind: 'review' | 'comment';
	state: string | null;
	/** Automated reviewer (GitHub App/Bot author) — excluded from human latency. */
	isBot: boolean;
	avatarUrl: string | null;
	/** Inline comments attached to a review submission. */
	commentsCount: number;
	ts: Date;
};

export type ReleaseFact = {
	owner: string;
	repo: string;
	tag: string;
	publishedAt: Date;
};

export type StockDay = {
	owner: string;
	repo: string;
	day: string; // YYYY-MM-DD, the as-of date
	issuesOpen: number;
	bugsOpen: number;
	prsOpen: number;
};

export type RepoSyncRow = {
	owner: string;
	repo: string;
	backfilledFrom: string; // YYYY-MM-DD
	activityBackfilledFrom: string; // YYYY-MM-DD
	/** How far back review facts exist; null (legacy row) = activityBackfilledFrom. */
	reviewBackfilledFrom: string | null; // YYYY-MM-DD
	syncedThrough: string; // YYYY-MM-DD
	fetchedAt: Date;
};

/** Everything the aggregator needs for one report, read in one pass. */
export type FactBundle = {
	prs: PrFact[];
	issues: IssueFact[];
	commits: CommitFact[];
	reviews: ReviewFact[];
	releases: ReleaseFact[];
	stocks: StockDay[];
};

export type Selection = {
	repos: Repo[];
	members: Member[];
	/** Number of months in the window (length of the range). */
	months: number;
	/** Months of per-member history (commits/merged/reviews/tickets). */
	memberMonths: number;
	/** End month of the window, "YYYY-MM". Omitted = the current month (rolling). */
	to?: string;
};

// ---- Attention worklist (live: currently-open PRs that need a human) --------
export type OpenPr = {
	repo: string; // owner/repo
	number: number;
	title: string;
	url: string;
	author: string; // login
	bot: boolean; // author is a GitHub App/Bot (e.g. dependabot)
	draft: boolean;
	createdAt: string;
	updatedAt: string;
	reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
	reviews: number;
	comments: number;
	additions: number;
	deletions: number;
};

export type AttentionReason =
	'unreviewed' | 'changes_requested' | 'stale' | 'aging' | 'draft_stale';

export type AttentionItem = OpenPr & {
	ageDays: number; // since opened
	idleDays: number; // since last activity
	reasons: AttentionReason[];
	priority: number; // higher = more in need of attention
};

export type AttentionResult = {
	items: AttentionItem[];
	summary: { total: number } & Record<AttentionReason, number>;
	generatedAt: number;
};

// ---- PR flow + review health (merged PRs in the window) ---------------------
export type PrFlow = {
	repo: string;
	month: string; // merge month (YYYY-MM)
	createdAt: string;
	mergedAt: string;
	firstReviewAt: string | null; // earliest review of any kind
	approvedAt: string | null; // earliest APPROVED review
	reviewers: string[]; // distinct reviewer logins
};

export type FlowStats = {
	count: number;
	reviewedPct: number; // share of merged PRs that got at least one review
	firstReviewHours: number; // median open -> first review (pickup)
	reviewHours: number; // median first review -> merged (review, incl. rework)
	mergeHours: number; // median open -> merged (total cycle time)
	postApproveHours: number; // median last approval -> merged (post-approval wait)
};

export type ReviewerLoad = { reviewer: string; prs: number };

/** Automated reviewer (CodeRabbit, CodeScene, Copilot, ...) activity on merged PRs. */
export type BotActivity = {
	login: string;
	avatarUrl: string; // GitHub App/bot avatar (no login `.png` for Apps)
	reviews: number; // APPROVED + CHANGES_REQUESTED submissions
	comments: number; // inline review comments left
	prs: number; // distinct PRs the bot reviewed (for comments-per-PR)
};

/** One bot's review/comment counts in one month, for trend charts. */
export type BotMonthActivity = {
	month: string;
	login: string;
	reviews: number;
	comments: number;
};

export type FlowResult = {
	overall: FlowStats;
	byMonth: ({ month: string } & FlowStats)[];
	reviewerLoad: ReviewerLoad[]; // distinct PRs each person reviewed
	botActivity: BotActivity[]; // automated reviewers, busiest first
	botByMonth: BotMonthActivity[]; // bot activity per month, for trends
	/** Rolling trailing-30d flow (current vs previous window) + the current
	 * window's reviewer load. Drives the rolling flow signals; absent on the
	 * no-DB live path, where signals fall back to the whole-window medians. */
	recent?: { current: FlowStats; previous: FlowStats; reviewerLoad: ReviewerLoad[] };
	generatedAt: number;
};
