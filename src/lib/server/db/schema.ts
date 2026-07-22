import {
	pgTable,
	text,
	integer,
	doublePrecision,
	jsonb,
	uuid,
	timestamp,
	boolean,
	primaryKey,
	index,
} from 'drizzle-orm/pg-core';
import type { Member, Repo } from '../github/types';

// ---------------------------------------------------------------------------
// LEGACY monthly report store, superseded by the fact store below (reports now
// aggregate facts at read time, so any window works and nothing keys off the
// in-progress calendar month). The tables are kept for rollback; no code reads
// or writes them anymore. Dropped in a follow-up once the fact store has proven
// itself in staging.
// ---------------------------------------------------------------------------

export const repoMonth = pgTable(
	'repo_month',
	{
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		month: text('month').notNull(), // YYYY-MM
		created: integer('created').notNull(),
		merged: integer('merged').notNull(),
		closed: integer('closed').notNull(),
		additions: integer('additions').notNull().default(0),
		deletions: integer('deletions').notNull().default(0),
		addPerPr: doublePrecision('add_per_pr').notNull(),
		delPerPr: doublePrecision('del_per_pr').notNull(),
		daysPerPr: doublePrecision('days_per_pr').notNull(),
		commentsPerPr: doublePrecision('comments_per_pr').notNull(),
		reviewsPerPr: doublePrecision('reviews_per_pr').notNull(),
		bugs: integer('bugs').notNull(),
		issues: integer('issues').notNull(),
		issuesOpen: integer('issues_open').notNull(),
		bugsOpen: integer('bugs_open').notNull(),
		prsOpen: integer('prs_open').notNull(),
		releases: integer('releases').notNull(),
		resolutionDays: doublePrecision('resolution_days').notNull(),
		resolutionRate: doublePrecision('resolution_rate').notNull(),
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.owner, t.repo, t.month] })],
);

export const memberRepoMonth = pgTable(
	'member_repo_month',
	{
		login: text('login').notNull(),
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		month: text('month').notNull(),
		commits: integer('commits').notNull(),
		// Burnout signals: how many of those commits landed on a weekend / late at
		// night in the author's own local time. Default 0 so rows from before this
		// column existed read as "unknown / none" rather than null.
		weekendCommits: integer('weekend_commits').notNull().default(0),
		lateNightCommits: integer('late_night_commits').notNull().default(0),
		// Recovery (time-off) detection: the 7-day bucket ids this member committed in
		// during the month, unioned across the window to find unbroken active streaks.
		activeWeeks: jsonb('active_weeks').$type<number[]>().notNull().default([]),
		mergedPrs: integer('merged_prs').notNull(),
		additions: integer('additions').notNull().default(0),
		deletions: integer('deletions').notNull().default(0),
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.login, t.owner, t.repo, t.month] })],
);

export const reviewRepoMonth = pgTable(
	'review_repo_month',
	{
		reviewer: text('reviewer').notNull(),
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		month: text('month').notNull(),
		reviews: integer('reviews').notNull(),
		comments: integer('comments').notNull(),
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
	},
	// Reads filter by (owner, repo, month) with no reviewer predicate, so the
	// reviewer-leading PK can't serve them; this index avoids a full table scan.
	(t) => [
		primaryKey({ columns: [t.reviewer, t.owner, t.repo, t.month] }),
		index('review_repo_month_lookup_idx').on(t.owner, t.repo, t.month),
	],
);

// Daily history of computed signal levels, so a point-in-time check (burnout,
// workload, ...) gains a timeline. Keyed by a stable repo-set hash (scopeKey) so
// the snapshot job and the page agree regardless of team identity. One row per
// (scope, signal, day): the warm job upserts today's row, last write wins.
export const signalSnapshot = pgTable(
	'signal_snapshot',
	{
		scope: text('scope').notNull(), // scopeKey(repos)
		signalId: text('signal_id').notNull(), // e.g. 'burnout'
		day: text('day').notNull(), // YYYY-MM-DD (UTC)
		level: text('level').notNull(), // 'ok' | 'warn' | 'bad'
		value: text('value').notNull(), // display value, e.g. '88%'
		ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.scope, t.signalId, t.day] }),
		// The page reads a scope's whole recent history; index that lookup.
		index('signal_snapshot_lookup_idx').on(t.scope, t.day),
	],
);

// ---------------------------------------------------------------------------
// Fact store: raw GitHub events at their native grain, so ANY window (a rolling
// 30 days, a calendar month, a quarter) aggregates exactly at read time and no
// surface has to key off the in-progress calendar month. Facts store what GitHub
// said, not what we concluded from it: labels stay raw (the bug matcher runs at
// read), commit timestamps keep their original offset (timezone classification
// runs at read), so config/roster/timezone changes are retroactive without a
// refetch. Sync state lives in repo_sync (a per-repo watermark), replacing the
// per-month staleness model.
// ---------------------------------------------------------------------------

export const prFact = pgTable(
	'pr_fact',
	{
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		number: integer('number').notNull(),
		author: text('author'), // GitHub login; null when the account is gone
		createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
		mergedAt: timestamp('merged_at', { withTimezone: true }),
		closedAt: timestamp('closed_at', { withTimezone: true }),
		additions: integer('additions').notNull().default(0),
		deletions: integer('deletions').notNull().default(0),
		comments: integer('comments').notNull().default(0),
		reviews: integer('reviews').notNull().default(0),
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.owner, t.repo, t.number] }),
		// Window reads filter on merged/created instants across a repo set.
		index('pr_fact_merged_idx').on(t.owner, t.repo, t.mergedAt),
		index('pr_fact_created_idx').on(t.owner, t.repo, t.createdAt),
	],
);

export const issueFact = pgTable(
	'issue_fact',
	{
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		number: integer('number').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
		closedAt: timestamp('closed_at', { withTimezone: true }),
		// Raw label names; the (configurable) bug matcher classifies at read time.
		labels: jsonb('labels').$type<string[]>().notNull().default([]),
		// GitHub native issue type name (e.g. "Bug"); a second defect signal beyond
		// labels. Null when the issue has no type, or predates this column's backfill.
		issueType: text('issue_type'),
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.owner, t.repo, t.number] }),
		index('issue_fact_created_idx').on(t.owner, t.repo, t.createdAt),
	],
);

export const commitFact = pgTable(
	'commit_fact',
	{
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		oid: text('oid').notNull(),
		authorLogin: text('author_login'), // linked GitHub identity, when any
		authorEmail: text('author_email'), // fallback attribution key
		// Raw ISO timestamp preserving the author's UTC offset — required for the
		// local-time burnout classification; committed_at is the same instant
		// normalized for range queries.
		committedDate: text('committed_date').notNull(),
		committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.owner, t.repo, t.oid] }),
		index('commit_fact_at_idx').on(t.owner, t.repo, t.committedAt),
	],
);

export const reviewFact = pgTable(
	'review_fact',
	{
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		id: text('id').notNull(), // GraphQL node id of the review / comment
		prNumber: integer('pr_number').notNull(),
		prAuthor: text('pr_author'), // for self-review exclusion at read time
		reviewer: text('reviewer').notNull(),
		kind: text('kind').notNull(), // 'review' | 'comment'
		state: text('state'), // review state (APPROVED, ...); null for comments
		// Bot reviewers (CodeRabbit, CodeScene, ...) are excluded from human review
		// latency and tallied on the Bots page instead; avatar_url renders there.
		isBot: boolean('is_bot').notNull().default(false),
		avatarUrl: text('avatar_url'),
		// Inline comments attached to a review submission (the Bots page's
		// comments-per-PR measure).
		commentsCount: integer('comments_count').notNull().default(0),
		ts: timestamp('ts', { withTimezone: true }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.owner, t.repo, t.id] }),
		index('review_fact_ts_idx').on(t.owner, t.repo, t.ts),
	],
);

export const releaseFact = pgTable(
	'release_fact',
	{
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		tag: text('tag').notNull(),
		publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.owner, t.repo, t.tag] }),
		index('release_fact_at_idx').on(t.owner, t.repo, t.publishedAt),
	],
);

// Open-stock (open PRs / issues / bugs) cannot be derived from a bounded fact
// backfill — an issue opened years ago may still be open. Snapshot the cheap
// cumulative counts as-of each month end (during backfill) and daily thereafter;
// a month bucket reads the latest snapshot at or before its end.
export const repoStockDay = pgTable(
	'repo_stock_day',
	{
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		day: text('day').notNull(), // YYYY-MM-DD (UTC), the as-of date
		issuesOpen: integer('issues_open').notNull(),
		bugsOpen: integer('bugs_open').notNull(),
		prsOpen: integer('prs_open').notNull(),
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.owner, t.repo, t.day] })],
);

// Per-repo sync watermark. backfilled_from marks how far back pr/issue/release
// facts exist; activity_backfilled_from bounds the heavier commit facts (member
// window only); review_backfilled_from bounds review facts (the flow window —
// null on legacy rows means "same as activity"). synced_through is the last day
// the recent tail was refreshed through; the refresh refetches a couple of days
// of overlap, so a PR that merged or an issue that closed since the last pass is
// picked up.
export const repoSync = pgTable(
	'repo_sync',
	{
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		backfilledFrom: text('backfilled_from').notNull(), // YYYY-MM-DD
		activityBackfilledFrom: text('activity_backfilled_from').notNull(), // YYYY-MM-DD
		reviewBackfilledFrom: text('review_backfilled_from'), // YYYY-MM-DD; null = activity_backfilled_from
		syncedThrough: text('synced_through').notNull(), // YYYY-MM-DD
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.owner, t.repo] })],
);

// ---------------------------------------------------------------------------
// Per-user teams (private to the OIDC subject) + audit trail.
// ---------------------------------------------------------------------------

export const team = pgTable(
	'team',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		ownerSub: text('owner_sub').notNull(),
		name: text('name').notNull(),
		members: jsonb('members').$type<Member[]>().notNull(),
		repos: jsonb('repos').$type<Repo[]>().notNull(),
		// Default IANA timezone for the team; members without their own inherit it for
		// burnout/recovery local-time classification. Null = use each commit's offset.
		tz: text('tz'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index('team_owner_idx').on(t.ownerSub)],
);

// Global, ownerless overrides of the env-configured default (built-in) teams.
// Any signed-in user may edit a default team in place; the edit is shared with
// everyone and keyed by the preset's positional built-in id (builtin:N). An
// absent row falls back to the env DEFAULT_TEAMS preset, so deleting a row resets
// the team to its configured default. Shape mirrors the per-user `team` table.
export const defaultTeamOverride = pgTable('default_team_override', {
	builtinId: text('builtin_id').primaryKey(), // e.g. 'builtin:0' / 'builtin:default'
	name: text('name').notNull(),
	members: jsonb('members').$type<Member[]>().notNull(),
	repos: jsonb('repos').$type<Repo[]>().notNull(),
	tz: text('tz'),
	lastEditedBy: text('last_edited_by'), // OIDC sub of the last editor
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Singleton app-wide configuration overrides (admin-editable). Each key that is
// absent falls back to its environment default, so an empty/missing row leaves
// behavior identical to a pure env configuration.
export const appConfig = pgTable('app_config', {
	id: text('id').primaryKey(), // always 'app'
	value: jsonb('value').$type<Record<string, unknown>>().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Wide per-user event log: one row per request (kind 'http'), per semantic action
// (kind 'action'), or per flagged abuse/auth event (kind 'security'). Best-effort;
// writing it must never break a request.
export const auditLog = pgTable(
	'audit_log',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		userSub: text('user_sub').notNull(),
		userEmail: text('user_email'),
		kind: text('kind').notNull().default('action'), // 'http' | 'action' | 'security'
		action: text('action').notNull(), // action name, or "METHOD /path" for requests
		method: text('method'),
		path: text('path'),
		status: integer('status'),
		durationMs: integer('duration_ms'),
		ip: text('ip'),
		userAgent: text('user_agent'),
		suspicious: boolean('suspicious').notNull().default(false),
		detail: jsonb('detail').$type<Record<string, unknown>>(),
		ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index('audit_user_idx').on(t.userSub),
		index('audit_ts_idx').on(t.ts),
		index('audit_kind_idx').on(t.kind),
		index('audit_suspicious_idx').on(t.suspicious),
	],
);
