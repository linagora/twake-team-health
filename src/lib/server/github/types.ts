export type Repo = { owner: string; repo: string };
export type Member = { login: string; name: string; email?: string };

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
	prsStale: number;
	releases: number;
	resolutionDays: number;
	resolutionStd: number;
	resolutionRate: number;
};

export type AuthorMonth = { author: string; month: string; commits: number };
export type MergedAuthorMonth = { author: string; month: string; mergedPRs: number };
export type ReviewActivity = { author: string; reviews: number; comments: number };
export type IssueMonth = { month: string; tickets: number; bugs: number };
/** New metric: commits by a member, broken down per repository, over the window. */
export type AuthorRepoCommits = { author: string; repo: string; commits: number };
/** Lines added/removed by a member's merged PRs, over the window. */
export type AuthorLines = { author: string; additions: number; deletions: number };

export type MetricsResult = {
	repos: RepoMonth[];
	authors: AuthorMonth[];
	mergedByAuthor: MergedAuthorMonth[];
	reviewActivity: ReviewActivity[];
	issuesByMonth: IssueMonth[];
	commitsByAuthorRepo: AuthorRepoCommits[];
	linesByAuthor: AuthorLines[];
	generatedAt: number;
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

export type AttentionReason = 'unreviewed' | 'changes_requested' | 'stale' | 'aging' | 'draft_stale';

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
	reviewHours: number; // median first review -> approved (review)
	mergeHours: number; // median open -> merged (total cycle time)
	postApproveHours: number; // median approved -> merged (merge wait)
};

export type ReviewerLoad = { reviewer: string; prs: number };

export type FlowResult = {
	overall: FlowStats;
	byMonth: ({ month: string } & FlowStats)[];
	reviewerLoad: ReviewerLoad[]; // distinct PRs each person reviewed
	generatedAt: number;
};
