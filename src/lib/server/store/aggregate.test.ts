import { describe, it, expect } from 'vitest';
import { buildStoredRows, aggregateRecent } from './aggregate';
import { makeBugMatcher } from '../github/stats';
import type {
	FactBundle,
	Member,
	PrFact,
	IssueFact,
	CommitFact,
	ReviewFact,
} from '../github/types';

const REPO = { owner: 'linagora', repo: 'a' };
const MONTHS = [
	{ year: 2026, month: 5 },
	{ year: 2026, month: 6 },
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

const issue = (o: Partial<IssueFact>): IssueFact => ({
	owner: 'linagora',
	repo: 'a',
	number: 1,
	createdAt: d('2026-06-01T00:00:00Z'),
	closedAt: null,
	labels: [],
	issueType: null,
	...o,
});

const isBug = makeBugMatcher();

const commit = (o: Partial<CommitFact>): CommitFact => ({
	owner: 'linagora',
	repo: 'a',
	oid: 'sha',
	authorLogin: 'alice',
	authorEmail: null,
	committedDate: '2026-06-10T10:00:00Z',
	committedAt: d('2026-06-10T10:00:00Z'),
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
	ts: d('2026-06-10T10:00:00Z'),
	...o,
});

const empty = (): FactBundle => ({
	prs: [],
	issues: [],
	commits: [],
	reviews: [],
	releases: [],
	stocks: [],
});

const MEMBERS: Member[] = [
	{ login: 'alice', name: 'Alice' },
	{ login: 'bob', name: 'Bob', email: 'bob@x.io' },
];

const OPTS = {
	repos: [REPO],
	members: MEMBERS,
	months: MONTHS,
	memberMonths: MONTHS,
	isBug: isBug,
};

describe('buildStoredRows: repo months', () => {
	it('buckets PR counts and merged-cohort stats by calendar month, zero-filling quiet months', () => {
		const bundle = empty();
		bundle.prs = [
			// merged in June, created in May (lead time spans months)
			pr({
				number: 1,
				createdAt: d('2026-05-30T00:00:00Z'),
				mergedAt: d('2026-06-01T00:00:00Z'),
				closedAt: d('2026-06-01T00:00:00Z'),
				additions: 10,
				deletions: 2,
				comments: 1,
				reviews: 2,
			}),
			pr({
				number: 2,
				createdAt: d('2026-06-02T00:00:00Z'),
				mergedAt: d('2026-06-04T00:00:00Z'),
				closedAt: d('2026-06-04T00:00:00Z'),
				additions: 30,
				deletions: 6,
				comments: 3,
				reviews: 4,
			}),
			// created in June, closed unmerged in June
			pr({
				number: 3,
				createdAt: d('2026-06-05T00:00:00Z'),
				closedAt: d('2026-06-06T00:00:00Z'),
			}),
			// still open, created in June
			pr({ number: 4, createdAt: d('2026-06-07T00:00:00Z') }),
		];
		const rows = buildStoredRows(bundle, OPTS).repoRows;
		expect(rows).toHaveLength(2); // May + June, May zero-filled

		const may = rows.find((r) => r.month === '2026-05')!;
		expect(may.created).toBe(1); // PR#1 was created in May
		expect(may.merged).toBe(0);

		const june = rows.find((r) => r.month === '2026-06')!;
		expect(june.created).toBe(3);
		expect(june.merged).toBe(2);
		expect(june.closed).toBe(3); // both merges + the unmerged close
		expect(june.additions).toBe(40);
		expect(june.deletions).toBe(8);
		expect(june.addPerPr).toBe(20); // median(10, 30)
		expect(june.daysPerPr).toBe(2); // median(2, 2)
		expect(june.commentsPerPr).toBe(2); // median(1, 3)
		expect(june.reviewsPerPr).toBe(3); // median(2, 4)
	});

	it('buckets issues, classifies bugs at read time, and computes resolution', () => {
		const bundle = empty();
		bundle.issues = [
			issue({
				number: 1,
				createdAt: d('2026-06-01T00:00:00Z'),
				closedAt: d('2026-06-11T00:00:00Z'),
				labels: ['bug'],
			}),
			issue({
				number: 2,
				createdAt: d('2026-06-02T00:00:00Z'),
				labels: ['Bug'],
			}), // open bug
			issue({
				number: 3,
				createdAt: d('2026-06-03T00:00:00Z'),
				labels: ['feature'],
			}),
			issue({
				number: 4,
				createdAt: d('2026-05-01T00:00:00Z'),
				closedAt: d('2026-06-02T00:00:00Z'),
			}), // May issue closed in June
		];
		const june = buildStoredRows(bundle, OPTS).repoRows.find((r) => r.month === '2026-06')!;
		expect(june.issues).toBe(3);
		expect(june.bugs).toBe(2);
		expect(june.resolutionDays).toBe(10); // the one closed bug
		expect(june.resolutionRate).toBe(50); // 1 of 2 bugs closed
	});

	it('classifies an unlabeled issue as a bug from its native issue type', () => {
		const bundle = empty();
		bundle.issues = [
			issue({ number: 1, createdAt: d('2026-06-01T00:00:00Z'), issueType: 'Bug' }), // no label
			issue({ number: 2, createdAt: d('2026-06-02T00:00:00Z'), issueType: 'Task' }),
		];
		const june = buildStoredRows(bundle, OPTS).repoRows.find((r) => r.month === '2026-06')!;
		expect(june.issues).toBe(2);
		expect(june.bugs).toBe(1); // only the Bug-typed issue, despite neither being labeled
	});

	it('reads open stock from the latest snapshot at or before each month end', () => {
		const bundle = empty();
		bundle.stocks = [
			{ ...REPO, day: '2026-05-31', issuesOpen: 7, bugsOpen: 2, prsOpen: 3 },
			{ ...REPO, day: '2026-06-30', issuesOpen: 9, bugsOpen: 1, prsOpen: 4 },
			{ ...REPO, day: '2026-07-04', issuesOpen: 99, bugsOpen: 99, prsOpen: 99 }, // after June: ignored
		];
		const rows = buildStoredRows(bundle, OPTS).repoRows;
		expect(rows.find((r) => r.month === '2026-05')).toMatchObject({
			issuesOpen: 7,
			bugsOpen: 2,
			prsOpen: 3,
		});
		expect(rows.find((r) => r.month === '2026-06')).toMatchObject({
			issuesOpen: 9,
			bugsOpen: 1,
			prsOpen: 4,
		});
	});

	it('counts releases per month', () => {
		const bundle = empty();
		bundle.releases = [
			{ ...REPO, tag: 'v1', publishedAt: d('2026-06-10T00:00:00Z') },
			{ ...REPO, tag: 'v2', publishedAt: d('2026-06-20T00:00:00Z') },
			{ ...REPO, tag: 'v0', publishedAt: d('2026-05-01T00:00:00Z') },
		];
		const rows = buildStoredRows(bundle, OPTS).repoRows;
		expect(rows.find((r) => r.month === '2026-06')!.releases).toBe(2);
		expect(rows.find((r) => r.month === '2026-05')!.releases).toBe(1);
	});
});

describe('buildStoredRows: member and review rows', () => {
	it('attributes commits by linked login, then unique member email', () => {
		const bundle = empty();
		bundle.commits = [
			commit({ oid: 's1', authorLogin: 'Alice' }), // case-insensitive login match
			commit({ oid: 's2', authorLogin: null, authorEmail: 'bob@x.io' }), // email fallback
			commit({ oid: 's3', authorLogin: 'stranger' }), // not a member
			commit({ oid: 's4', authorLogin: null, authorEmail: 'nobody@x.io' }),
		];
		const rows = buildStoredRows(bundle, OPTS).memberRows;
		expect(rows.find((r) => r.login === 'alice')?.commits).toBe(1);
		expect(rows.find((r) => r.login === 'bob')?.commits).toBe(1);
		expect(rows.filter((r) => r.commits > 0)).toHaveLength(2);
	});

	it('classifies weekend commits with the member timezone at read time', () => {
		// 2026-06-06 is a Saturday. 23:30 UTC on Friday is Saturday 06:30 in Hanoi.
		const members: Member[] = [{ login: 'alice', name: 'Alice', tz: 'Asia/Ho_Chi_Minh' }];
		const bundle = empty();
		bundle.commits = [
			commit({
				oid: 's1',
				committedDate: '2026-06-05T23:30:00Z',
				committedAt: d('2026-06-05T23:30:00Z'),
			}),
		];
		const rows = buildStoredRows(bundle, { ...OPTS, members }).memberRows;
		expect(rows[0].weekendCommits).toBe(1); // Saturday in Hanoi, still Friday in UTC
	});

	it('sums merged PRs and line volume per member from PR facts', () => {
		const bundle = empty();
		bundle.prs = [
			pr({
				number: 1,
				author: 'alice',
				mergedAt: d('2026-06-03T00:00:00Z'),
				closedAt: d('2026-06-03T00:00:00Z'),
				additions: 100,
				deletions: 20,
			}),
			pr({
				number: 2,
				author: 'ALICE',
				mergedAt: d('2026-06-05T00:00:00Z'),
				closedAt: d('2026-06-05T00:00:00Z'),
				additions: 50,
				deletions: 5,
			}),
			pr({
				number: 3,
				author: 'stranger',
				mergedAt: d('2026-06-05T00:00:00Z'),
				closedAt: d('2026-06-05T00:00:00Z'),
				additions: 9,
				deletions: 9,
			}),
		];
		const alice = buildStoredRows(bundle, OPTS).memberRows.find((r) => r.login === 'alice')!;
		expect(alice.mergedPrs).toBe(2);
		expect(alice.additions).toBe(150);
		expect(alice.deletions).toBe(25);
	});

	it('counts review activity per reviewer, excluding self-review and PENDING', () => {
		const bundle = empty();
		bundle.reviews = [
			review({ id: 'r1', reviewer: 'bob' }),
			review({ id: 'r2', reviewer: 'alice', prAuthor: 'alice' }), // self: dropped
			review({ id: 'r3', reviewer: 'bob', state: 'PENDING' }), // pending: dropped
			review({ id: 'c1', reviewer: 'carol', kind: 'comment', state: null }),
		];
		const rows = buildStoredRows(bundle, OPTS).reviewRows;
		expect(rows.find((r) => r.reviewer === 'bob')).toMatchObject({
			reviews: 1,
			comments: 0,
		});
		expect(rows.find((r) => r.reviewer === 'carol')).toMatchObject({
			reviews: 0,
			comments: 1,
		}); // non-member kept for "Others"
		expect(rows.find((r) => r.reviewer === 'alice')).toBeUndefined();
	});
});

describe('aggregateRecent', () => {
	// Windows ending Jul 5: current = Jun 6..Jul 5, previous = May 7..Jun 5.
	const END = '2026-07-05';

	it('splits headline counts between the current and previous 30-day windows', () => {
		const bundle = empty();
		bundle.prs = [
			pr({
				number: 1,
				createdAt: d('2026-07-01T00:00:00Z'),
				mergedAt: d('2026-07-02T00:00:00Z'),
				closedAt: d('2026-07-02T00:00:00Z'),
			}), // current
			pr({
				number: 2,
				createdAt: d('2026-06-01T00:00:00Z'),
				mergedAt: d('2026-06-02T00:00:00Z'),
				closedAt: d('2026-06-02T00:00:00Z'),
			}), // previous
			pr({ number: 3, createdAt: d('2026-04-01T00:00:00Z') }), // outside both
		];
		bundle.issues = [
			issue({
				number: 1,
				createdAt: d('2026-06-20T00:00:00Z'),
				labels: ['bug'],
			}),
			issue({ number: 2, createdAt: d('2026-05-20T00:00:00Z') }),
		];
		const { window30d } = aggregateRecent(bundle, [REPO], MEMBERS, isBug, END, 123);
		expect(window30d.current).toEqual({
			created: 1,
			merged: 1,
			issues: 1,
			bugs: 1,
		});
		expect(window30d.previous).toEqual({
			created: 1,
			merged: 1,
			issues: 1,
			bugs: 0,
		});
		expect(window30d.computedAt).toBe(123);
	});

	it('sums per-member trailing-30d activity across sources', () => {
		const bundle = empty();
		bundle.commits = [
			commit({
				oid: 's1',
				committedDate: '2026-07-01T10:00:00Z',
				committedAt: d('2026-07-01T10:00:00Z'),
			}),
			commit({
				oid: 's2',
				committedDate: '2026-05-10T10:00:00Z',
				committedAt: d('2026-05-10T10:00:00Z'),
			}), // previous window: not counted
		];
		bundle.prs = [
			pr({
				number: 1,
				author: 'alice',
				mergedAt: d('2026-06-20T00:00:00Z'),
				closedAt: d('2026-06-20T00:00:00Z'),
				additions: 10,
				deletions: 1,
			}),
		];
		bundle.reviews = [
			review({ id: 'r1', reviewer: 'bob', ts: d('2026-06-25T00:00:00Z') }),
			review({
				id: 'c1',
				reviewer: 'bob',
				kind: 'comment',
				state: null,
				ts: d('2026-06-25T01:00:00Z'),
			}),
		];
		const { recentMembers } = aggregateRecent(bundle, [REPO], MEMBERS, isBug, END, 0);
		expect(recentMembers.find((r) => r.login === 'alice')).toMatchObject({
			commits: 1,
			mergedPrs: 1,
			additions: 10,
		});
		expect(recentMembers.find((r) => r.login === 'bob')).toMatchObject({
			reviews: 1,
			comments: 1,
		});
	});

	it('ignores repos outside the selection', () => {
		const bundle = empty();
		bundle.prs = [pr({ repo: 'other', number: 1, createdAt: d('2026-07-01T00:00:00Z') })];
		const { window30d } = aggregateRecent(bundle, [REPO], MEMBERS, isBug, END, 0);
		expect(window30d.current.created).toBe(0);
	});

	it('counts distinct repos each member committed to in the window (breadth)', () => {
		const bundle = empty();
		bundle.commits = [
			commit({ oid: 'a1', repo: 'a', committedAt: d('2026-07-01T10:00:00Z'), committedDate: '2026-07-01T10:00:00Z' }),
			commit({ oid: 'a2', repo: 'a', committedAt: d('2026-07-03T10:00:00Z'), committedDate: '2026-07-03T10:00:00Z' }),
			commit({ oid: 'b1', repo: 'b', committedAt: d('2026-07-02T10:00:00Z'), committedDate: '2026-07-02T10:00:00Z' }),
			// previous window: not counted toward breadth
			commit({ oid: 'c1', repo: 'c', committedAt: d('2026-05-10T10:00:00Z'), committedDate: '2026-05-10T10:00:00Z' }),
		];
		const repos = [REPO, { owner: 'linagora', repo: 'b' }, { owner: 'linagora', repo: 'c' }];
		const { recentMembers } = aggregateRecent(bundle, repos, MEMBERS, isBug, END, 0);
		expect(recentMembers.find((r) => r.login === 'alice')).toMatchObject({ commits: 3, repos: 2 });
	});

	it('reports per-repo current vs previous window activity', () => {
		const bundle = empty();
		bundle.prs = [
			pr({ repo: 'a', number: 1, mergedAt: d('2026-07-01T00:00:00Z') }), // current
			pr({ repo: 'a', number: 2, mergedAt: d('2026-05-20T00:00:00Z') }), // previous
			pr({ repo: 'b', number: 3, createdAt: d('2026-06-20T00:00:00Z') }), // current, created only
		];
		const repos = [REPO, { owner: 'linagora', repo: 'b' }];
		const { recentRepos } = aggregateRecent(bundle, repos, MEMBERS, isBug, END, 0);
		const a = recentRepos.find((r) => r.repo === 'a')!;
		expect(a.current.merged).toBe(1);
		expect(a.previous.merged).toBe(1);
		const b = recentRepos.find((r) => r.repo === 'b')!;
		expect(b.current.created).toBe(1);
		expect(b.current.merged).toBe(0);
	});

	it('produces a rolling per-member work pattern over the current window', () => {
		const bundle = empty();
		bundle.commits = [
			commit({ oid: 'w1', committedDate: '2026-07-01T10:00:00Z', committedAt: d('2026-07-01T10:00:00Z') }),
			commit({ oid: 'w2', committedDate: '2026-07-02T10:00:00Z', committedAt: d('2026-07-02T10:00:00Z') }),
			// previous window: excluded from the rolling pattern
			commit({ oid: 'w3', committedDate: '2026-05-10T10:00:00Z', committedAt: d('2026-05-10T10:00:00Z') }),
		];
		const { recentWorkPattern } = aggregateRecent(bundle, [REPO], MEMBERS, isBug, END, 0);
		const a = recentWorkPattern.find((w) => w.author === 'alice')!;
		expect(a.commits).toBe(2);
		expect(a.activeWeeks.length).toBeGreaterThan(0);
	});

	it('builds a continuous zero-filled daily series over the 2N-day span', () => {
		const bundle = empty();
		bundle.prs = [pr({ number: 1, createdAt: d('2026-06-20T00:00:00Z'), mergedAt: d('2026-07-01T12:00:00Z') })];
		bundle.issues = [issue({ number: 1, createdAt: d('2026-06-25T00:00:00Z'), labels: ['bug'] })];
		const { recentDaily } = aggregateRecent(bundle, [REPO], MEMBERS, isBug, END, 0);
		expect(recentDaily.length).toBe(60);
		expect(recentDaily[0].day).toBe('2026-05-07');
		expect(recentDaily.at(-1)!.day).toBe('2026-07-05');
		expect(recentDaily.find((x) => x.day === '2026-07-01')!.merged).toBe(1);
		expect(recentDaily.find((x) => x.day === '2026-06-20')!.created).toBe(1);
		expect(recentDaily.find((x) => x.day === '2026-06-25')!.bugs).toBe(1);
	});
});
