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
	index
} from 'drizzle-orm/pg-core';
import type { Member, Repo } from '../github/types';

// ---------------------------------------------------------------------------
// Composable monthly report store. Each row is a fact for one (entity, month),
// reused by every team. A completed month is written once and never refetched.
// The current (in-progress) month is also stored, with `fetched_at` recording
// when it was last pulled from GitHub; it is refreshed only once it goes stale
// (CURRENT_MONTH_TTL_MS), so the shared token isn't hit on every request.
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
		prsStale: integer('prs_stale').notNull(),
		releases: integer('releases').notNull(),
		resolutionDays: doublePrecision('resolution_days').notNull(),
		resolutionStd: doublePrecision('resolution_std').notNull(),
		resolutionRate: doublePrecision('resolution_rate').notNull(),
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull()
	},
	(t) => [primaryKey({ columns: [t.owner, t.repo, t.month] })]
);

export const memberRepoMonth = pgTable(
	'member_repo_month',
	{
		login: text('login').notNull(),
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		month: text('month').notNull(),
		commits: integer('commits').notNull(),
		mergedPrs: integer('merged_prs').notNull(),
		additions: integer('additions').notNull().default(0),
		deletions: integer('deletions').notNull().default(0),
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull()
	},
	(t) => [primaryKey({ columns: [t.login, t.owner, t.repo, t.month] })]
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
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull()
	},
	// Reads filter by (owner, repo, month) with no reviewer predicate, so the
	// reviewer-leading PK can't serve them; this index avoids a full table scan.
	(t) => [
		primaryKey({ columns: [t.reviewer, t.owner, t.repo, t.month] }),
		index('review_repo_month_lookup_idx').on(t.owner, t.repo, t.month)
	]
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
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(t) => [index('team_owner_idx').on(t.ownerSub)]
);

// Singleton app-wide configuration overrides (admin-editable). Each key that is
// absent falls back to its environment default, so an empty/missing row leaves
// behavior identical to a pure env configuration.
export const appConfig = pgTable('app_config', {
	id: text('id').primaryKey(), // always 'app'
	value: jsonb('value').$type<Record<string, unknown>>().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
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
		ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull()
	},
	(t) => [
		index('audit_user_idx').on(t.userSub),
		index('audit_ts_idx').on(t.ts),
		index('audit_kind_idx').on(t.kind),
		index('audit_suspicious_idx').on(t.suspicious)
	]
);
