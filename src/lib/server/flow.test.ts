import { describe, it, expect } from 'vitest';
import { computeFlow, rollingFlow } from './flow';
import type { PrFlow } from './github/types';

const NOW = Date.parse('2026-06-26T00:00:00Z');
const BASE = '2026-06-10T00:00:00Z';
const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.parse(BASE) + hours * HOUR).toISOString();

const prs: PrFlow[] = [
	{
		repo: 'o/r',
		month: '2026-06',
		createdAt: BASE,
		mergedAt: at(24),
		firstReviewAt: at(2),
		approvedAt: at(20),
		reviewers: ['alice', 'bob'],
	},
	{
		repo: 'o/r',
		month: '2026-06',
		createdAt: BASE,
		mergedAt: at(10),
		firstReviewAt: null,
		approvedAt: null,
		reviewers: [],
	},
	{
		repo: 'o/r',
		month: '2026-06',
		createdAt: BASE,
		mergedAt: at(36),
		firstReviewAt: at(6),
		approvedAt: at(30),
		reviewers: ['alice'],
	},
];

describe('computeFlow', () => {
	const r = computeFlow(prs, ['2026-06'], NOW);

	it('medians each cycle-time stage and review coverage', () => {
		expect(r.overall.count).toBe(3);
		expect(r.overall.reviewedPct).toBe(67); // 2 of 3 reviewed
		expect(r.overall.firstReviewHours).toBe(4); // median(2, 6)
		expect(r.overall.reviewHours).toBe(26); // first review -> merge: median(24-2, 36-6) = median(22, 30)
		expect(r.overall.mergeHours).toBe(24); // median(10, 24, 36)
		expect(r.overall.postApproveHours).toBe(5); // median(4, 6)
	});

	it('ranks reviewer load by distinct PRs reviewed', () => {
		expect(r.reviewerLoad).toEqual([
			{ reviewer: 'alice', prs: 2 },
			{ reviewer: 'bob', prs: 1 },
		]);
	});

	it('breaks stats down per month', () => {
		expect(r.byMonth).toHaveLength(1);
		expect(r.byMonth[0]).toMatchObject({ month: '2026-06', count: 3 });
	});
});

// --- fact-backed flow reconstruction -----------------------------------------
import { buildFlowFromFacts } from './flow';
import type { PrFact, ReviewFact } from './github/types';

const dd = (iso: string) => new Date(iso);

const prFact = (o: Partial<PrFact>): PrFact => ({
	owner: 'o',
	repo: 'r',
	number: 1,
	author: 'alice',
	createdAt: dd('2026-06-10T00:00:00Z'),
	mergedAt: dd('2026-06-11T00:00:00Z'),
	closedAt: dd('2026-06-11T00:00:00Z'),
	additions: 0,
	deletions: 0,
	comments: 0,
	reviews: 0,
	...o,
});

const rf = (o: Partial<ReviewFact>): ReviewFact => ({
	owner: 'o',
	repo: 'r',
	id: 'id',
	prNumber: 1,
	prAuthor: 'alice',
	reviewer: 'bob',
	kind: 'review',
	state: 'COMMENTED',
	isBot: false,
	avatarUrl: null,
	commentsCount: 0,
	ts: dd('2026-06-10T02:00:00Z'),
	...o,
});

describe('buildFlowFromFacts', () => {
	const months = new Set(['2026-06']);

	it('reconstructs the human review timeline: first review, LAST gating approval, reviewers', () => {
		const reviews = [
			rf({ id: 'r1', reviewer: 'bob', ts: dd('2026-06-10T02:00:00Z') }),
			rf({ id: 'r2', reviewer: 'carol', state: 'APPROVED', ts: dd('2026-06-10T05:00:00Z') }),
			rf({ id: 'r3', reviewer: 'carol', state: 'APPROVED', ts: dd('2026-06-10T20:00:00Z') }), // re-approve after rework
			rf({ id: 'r4', reviewer: 'dave', state: 'APPROVED', ts: dd('2026-06-12T00:00:00Z') }), // after merge: not gating
		];
		const { prs } = buildFlowFromFacts([prFact({})], reviews, months);
		expect(prs).toHaveLength(1);
		expect(prs[0].firstReviewAt).toBe('2026-06-10T02:00:00.000Z');
		expect(prs[0].approvedAt).toBe('2026-06-10T20:00:00.000Z'); // last approval before merge
		expect(prs[0].reviewers.sort()).toEqual(['bob', 'carol', 'dave']);
	});

	it('excludes bots from human latency but tallies them for the bots page', () => {
		const reviews = [
			rf({
				id: 'b1',
				reviewer: 'coderabbitai',
				isBot: true,
				state: 'COMMENTED',
				commentsCount: 7,
				ts: dd('2026-06-10T00:30:00Z'),
				avatarUrl: 'a.png',
			}),
			rf({
				id: 'b2',
				reviewer: 'coderabbitai',
				isBot: true,
				state: 'APPROVED',
				commentsCount: 2,
				ts: dd('2026-06-10T01:00:00Z'),
			}),
			rf({ id: 'h1', reviewer: 'bob', ts: dd('2026-06-10T04:00:00Z') }),
		];
		const { prs, botActivity, botByMonth } = buildFlowFromFacts([prFact({})], reviews, months);
		expect(prs[0].firstReviewAt).toBe('2026-06-10T04:00:00.000Z'); // bot at 00:30 ignored
		expect(prs[0].reviewers).toEqual(['bob']);
		expect(botActivity).toEqual([
			{ login: 'coderabbitai', avatarUrl: 'a.png', reviews: 1, comments: 9, prs: 1 },
		]);
		expect(botByMonth).toEqual([
			{ month: '2026-06', login: 'coderabbitai', reviews: 1, comments: 9 },
		]);
	});

	it('keeps only PRs merged inside the requested months and ignores unmerged ones', () => {
		const prs = [
			prFact({ number: 1 }),
			prFact({
				number: 2,
				mergedAt: dd('2026-05-01T00:00:00Z'),
				closedAt: dd('2026-05-01T00:00:00Z'),
			}), // outside window
			prFact({ number: 3, mergedAt: null, closedAt: null }), // open
		];
		const built = buildFlowFromFacts(prs, [], months);
		expect(built.prs).toHaveLength(1);
		expect(built.prs[0].month).toBe('2026-06');
	});

	it('ignores PR issue-comments (kind comment) in the review timeline', () => {
		const reviews = [
			rf({ id: 'c1', kind: 'comment', state: null, ts: dd('2026-06-10T01:00:00Z') }),
		];
		const { prs } = buildFlowFromFacts([prFact({})], reviews, months);
		expect(prs[0].firstReviewAt).toBeNull();
	});
});

describe('rollingFlow', () => {
	// Windows ending Jul 5: current = Jun 6..Jul 5, previous = May 7..Jun 5.
	const END = '2026-07-05';

	it('splits flow stats between the current and previous 30-day merge windows', () => {
		const prs: PrFact[] = [
			prFact({
				number: 1,
				createdAt: dd('2026-06-30T00:00:00Z'),
				mergedAt: dd('2026-07-01T00:00:00Z'),
				closedAt: dd('2026-07-01T00:00:00Z'),
			}), // current, reviewed
			prFact({
				number: 2,
				createdAt: dd('2026-05-20T00:00:00Z'),
				mergedAt: dd('2026-05-25T00:00:00Z'),
				closedAt: dd('2026-05-25T00:00:00Z'),
			}), // previous, unreviewed
		];
		const reviews: ReviewFact[] = [
			rf({ id: 'r1', prNumber: 1, reviewer: 'bob', ts: dd('2026-06-30T06:00:00Z') }),
		];
		const { current, previous, reviewerLoad } = rollingFlow(prs, reviews, END);
		expect(current.count).toBe(1);
		expect(current.reviewedPct).toBe(100);
		expect(previous.count).toBe(1);
		expect(previous.reviewedPct).toBe(0);
		expect(reviewerLoad).toEqual([{ reviewer: 'bob', prs: 1 }]);
	});
});
