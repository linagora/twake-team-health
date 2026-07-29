import { describe, it, expect } from 'vitest';
import { buildPersonStats, MIN_MEDIAN_SAMPLE } from './person';
import type { FactBundle, Member, PrFact, CommitFact, ReviewFact } from './github/types';

const REPOS = [{ owner: 'linagora', repo: 'a' }];
const MONTHS = [
	{ year: 2026, month: 5 },
	{ year: 2026, month: 6 },
];
const MEMBERS: Member[] = [
	{ login: 'alice', name: 'Alice', email: 'alice@x.io' },
	{ login: 'bob', name: 'Bob' },
];

const d = (iso: string) => new Date(iso);

const pr = (o: Partial<PrFact>): PrFact => ({
	owner: 'linagora',
	repo: 'a',
	number: 1,
	author: 'alice',
	createdAt: d('2026-06-01T00:00:00Z'),
	mergedAt: null,
	closedAt: null,
	additions: 0,
	deletions: 0,
	comments: 0,
	reviews: 0,
	...o,
});

const review = (o: Partial<ReviewFact>): ReviewFact => ({
	owner: 'linagora',
	repo: 'a',
	id: 'r1',
	prNumber: 1,
	prAuthor: 'alice',
	reviewer: 'bob',
	kind: 'review',
	state: 'APPROVED',
	isBot: false,
	avatarUrl: null,
	commentsCount: 0,
	ts: d('2026-06-02T00:00:00Z'),
	...o,
});

const commit = (o: Partial<CommitFact>): CommitFact => ({
	owner: 'linagora',
	repo: 'a',
	oid: 'sha1',
	authorLogin: 'alice',
	authorEmail: null,
	committedDate: '2026-06-10T10:00:00Z',
	committedAt: d('2026-06-10T10:00:00Z'),
	...o,
});

const bundle = (o: Partial<FactBundle>): FactBundle => ({
	prs: [],
	issues: [],
	commits: [],
	reviews: [],
	releases: [],
	stocks: [],
	...o,
});

const build = (b: Partial<FactBundle>, login = 'alice') =>
	buildPersonStats(bundle(b), { repos: REPOS, members: MEMBERS, login, months: MONTHS }, 0);

describe('buildPersonStats', () => {
	it('zero-fills every month of the window', () => {
		const r = build({});
		expect(r.byMonth.map((m) => m.month)).toEqual(['2026-05', '2026-06']);
		expect(r.byMonth.every((m) => m.commits === 0 && m.prsMerged === 0)).toBe(true);
		expect(r.totals.prsCreated).toBe(0);
	});

	it('counts authored PRs as created, merged and closed-unmerged', () => {
		const r = build({
			prs: [
				pr({ number: 1, createdAt: d('2026-05-01T00:00:00Z'), mergedAt: d('2026-05-03T00:00:00Z') }),
				pr({ number: 2, createdAt: d('2026-06-01T00:00:00Z') }), // still open
				pr({ number: 3, createdAt: d('2026-06-01T00:00:00Z'), closedAt: d('2026-06-05T00:00:00Z') }),
			],
		});
		expect(r.totals.prsCreated).toBe(3);
		expect(r.totals.prsMerged).toBe(1);
		expect(r.totals.prsClosedUnmerged).toBe(1);
		expect(r.totals.mergeRatePct).toBe(50);
		expect(r.byMonth[0].prsMerged).toBe(1);
		expect(r.byMonth[1].prsCreated).toBe(2);
	});

	it('ignores PRs authored by other people', () => {
		const r = build({ prs: [pr({ author: 'bob', mergedAt: d('2026-06-02T00:00:00Z') })] });
		expect(r.totals.prsCreated).toBe(0);
		expect(r.totals.prsMerged).toBe(0);
	});

	it('matches the roster login case-insensitively', () => {
		const r = build({
			prs: [pr({ author: 'ALICE', mergedAt: d('2026-06-02T00:00:00Z') })],
			commits: [commit({ authorLogin: 'Alice' })],
		});
		expect(r.totals.prsMerged).toBe(1);
		expect(r.byMonth[1].commits).toBe(1);
	});

	it('attributes commits by unique member email when no login is linked', () => {
		const r = build({ commits: [commit({ authorLogin: null, authorEmail: 'ALICE@x.io' })] });
		expect(r.byMonth[1].commits).toBe(1);
	});

	it('sums merged PR line counts into the merge month', () => {
		const r = build({
			prs: [
				pr({ number: 1, mergedAt: d('2026-06-02T00:00:00Z'), additions: 30, deletions: 4 }),
				pr({ number: 2, mergedAt: d('2026-06-03T00:00:00Z'), additions: 10, deletions: 1 }),
			],
		});
		expect(r.byMonth[1].additions).toBe(40);
		expect(r.byMonth[1].deletions).toBe(5);
	});

	it('reports totals medians only above the sample floor', () => {
		const below = build({
			prs: [
				pr({ number: 1, mergedAt: d('2026-06-02T00:00:00Z'), additions: 10 }),
				pr({ number: 2, mergedAt: d('2026-06-03T00:00:00Z'), additions: 20 }),
			],
		});
		expect(MIN_MEDIAN_SAMPLE).toBe(3);
		expect(below.totals.medianPrSize).toBeNull();
		expect(below.totals.medianCycleHours).toBeNull();

		const at = build({
			prs: [1, 2, 3].map((n) =>
				pr({
					number: n,
					createdAt: d('2026-06-01T00:00:00Z'),
					mergedAt: d('2026-06-01T12:00:00Z'),
					additions: n * 10,
				}),
			),
		});
		expect(at.totals.medianPrSize).toBe(20);
		expect(at.totals.medianCycleHours).toBe(12);
	});

	it('reports a per-month median from a single PR (no floor on the series)', () => {
		const r = build({
			prs: [pr({ createdAt: d('2026-06-01T00:00:00Z'), mergedAt: d('2026-06-01T06:00:00Z') })],
		});
		expect(r.byMonth[1].cycleHours).toBe(6);
		expect(r.byMonth[0].cycleHours).toBeNull(); // nothing merged in May
	});

	it('splits review work given into submissions, comments and verdicts', () => {
		const r = build(
			{
				reviews: [
					review({ id: 'a', prAuthor: 'bob', reviewer: 'alice', state: 'APPROVED' }),
					review({ id: 'b', prAuthor: 'bob', reviewer: 'alice', state: 'CHANGES_REQUESTED' }),
					review({ id: 'c', prAuthor: 'bob', reviewer: 'alice', kind: 'comment', state: null }),
				],
			},
			'alice',
		);
		expect(r.totals.reviewsGiven).toBe(2);
		expect(r.totals.commentsGiven).toBe(1);
		expect(r.totals.approvals).toBe(1);
		expect(r.totals.changesRequested).toBe(1);
		expect(r.byMonth[1].reviewsGiven).toBe(2);
		expect(r.byMonth[1].commentsGiven).toBe(1);
	});

	it('counts distinct PRs reviewed, not review submissions', () => {
		const r = build({
			reviews: [
				review({ id: 'a', prNumber: 7, prAuthor: 'bob', reviewer: 'alice' }),
				review({ id: 'b', prNumber: 7, prAuthor: 'bob', reviewer: 'alice' }),
				review({ id: 'c', prNumber: 8, prAuthor: 'bob', reviewer: 'alice' }),
			],
		});
		expect(r.totals.reviewsGiven).toBe(3);
		expect(r.totals.prsReviewed).toBe(2);
	});

	it('excludes self-reviews, PENDING drafts and bots', () => {
		const r = build({
			reviews: [
				review({ id: 'a', prAuthor: 'alice', reviewer: 'alice' }), // self
				review({ id: 'b', prAuthor: 'bob', reviewer: 'alice', state: 'PENDING' }),
				review({ id: 'c', prAuthor: 'alice', reviewer: 'coderabbit', isBot: true }),
			],
		});
		expect(r.totals.reviewsGiven).toBe(0);
		expect(r.totals.reviewsReceived).toBe(0);
		expect(r.totals.reviewersDistinct).toBe(0);
		expect(r.peers).toEqual([]);
	});

	it('measures pickup latency from the PR opening to their first review of it', () => {
		const r = build({
			prs: [pr({ number: 5, author: 'bob', createdAt: d('2026-06-01T00:00:00Z') })],
			reviews: [
				review({ id: 'b', prNumber: 5, prAuthor: 'bob', reviewer: 'alice', ts: d('2026-06-01T09:00:00Z') }),
				review({ id: 'a', prNumber: 5, prAuthor: 'bob', reviewer: 'alice', ts: d('2026-06-01T04:00:00Z') }),
			],
		});
		expect(r.byMonth[1].pickupHours).toBe(4); // the earliest, not the latest
	});

	it('measures the wait their own PRs endured and flags unreviewed merges', () => {
		const r = build({
			prs: [
				pr({ number: 1, createdAt: d('2026-06-01T00:00:00Z'), mergedAt: d('2026-06-02T00:00:00Z') }),
				pr({ number: 2, createdAt: d('2026-06-01T00:00:00Z'), mergedAt: d('2026-06-02T00:00:00Z') }),
			],
			reviews: [
				review({ id: 'a', prNumber: 1, prAuthor: 'alice', reviewer: 'bob', ts: d('2026-06-01T05:00:00Z') }),
			],
		});
		expect(r.totals.reviewsReceived).toBe(1);
		expect(r.totals.reviewersDistinct).toBe(1);
		expect(r.totals.unreviewedMerges).toBe(1); // PR 2 got nothing
		expect(r.byMonth[1].reviewsReceived).toBe(1);
	});

	it('counts a bot-only review as an unreviewed merge', () => {
		const r = build({
			prs: [pr({ number: 1, createdAt: d('2026-06-01T00:00:00Z'), mergedAt: d('2026-06-02T00:00:00Z') })],
			reviews: [review({ id: 'a', prNumber: 1, reviewer: 'coderabbit', isBot: true })],
		});
		expect(r.totals.unreviewedMerges).toBe(1);
	});

	it('tallies peers in both directions, busiest exchange first', () => {
		const r = build({
			reviews: [
				review({ id: 'a', prNumber: 2, prAuthor: 'bob', reviewer: 'alice' }),
				review({ id: 'b', prNumber: 2, prAuthor: 'bob', reviewer: 'alice' }),
				review({ id: 'c', prNumber: 1, prAuthor: 'alice', reviewer: 'bob' }),
				review({ id: 'd', prNumber: 3, prAuthor: 'carol', reviewer: 'alice' }),
			],
		});
		expect(r.peers).toEqual([
			{ login: 'bob', given: 2, received: 1 },
			// Non-members still count: review traffic with them is real collaboration.
			{ login: 'carol', given: 1, received: 0 },
		]);
	});

	it('ignores facts outside the window and outside the repo selection', () => {
		const r = build({
			prs: [
				pr({ number: 1, createdAt: d('2026-04-01T00:00:00Z'), mergedAt: d('2026-04-02T00:00:00Z') }),
				pr({ number: 2, repo: 'other', mergedAt: d('2026-06-02T00:00:00Z') }),
			],
			commits: [
				commit({ oid: 'old', committedAt: d('2026-04-10T00:00:00Z') }),
				commit({ oid: 'elsewhere', repo: 'other' }),
			],
		});
		expect(r.totals.prsMerged).toBe(0);
		expect(r.byMonth.reduce((s, m) => s + m.commits, 0)).toBe(0);
	});

	it('returns an all-zero report for a login outside the roster', () => {
		const r = build({ prs: [pr({ author: 'mallory', mergedAt: d('2026-06-02T00:00:00Z') })] }, 'mallory');
		expect(r.login).toBe('mallory');
		expect(r.totals.prsMerged).toBe(0);
		expect(r.peers).toEqual([]);
	});
});
