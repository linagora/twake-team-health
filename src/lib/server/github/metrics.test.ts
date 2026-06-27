import { describe, it, expect } from 'vitest';
import {
	prStatsForMonth,
	issueStatsForMonth,
	reviewCountsFromNodes,
	commitShasForMember,
	pickCommitMember
} from './metrics';
import { median, std, isBugLabel } from './stats';
import { lastNMonths, monthKey, monthEnd } from './months';

describe('stats helpers', () => {
	it('median handles odd and even counts', () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(median([])).toBe(0);
	});
	it('std is sample stdev, 0 for <2 values', () => {
		expect(std([5])).toBe(0);
		expect(std([2, 4])).toBe(1.41);
	});
	it('pickCommitMember attributes one member: login wins, email is fallback', () => {
		const byLogin = new Map([['alice', 'alice']]);
		const byEmail = new Map([['bob@x.com', 'bob']]);
		// login matches alice AND email maps to bob -> login wins, counted once
		expect(pickCommitMember({ user: { login: 'Alice' }, email: 'bob@x.com' }, byLogin, byEmail)).toBe('alice');
		// no login match -> email fallback
		expect(pickCommitMember({ user: null, email: 'BOB@x.com' }, byLogin, byEmail)).toBe('bob');
		// neither matches
		expect(pickCommitMember({ user: { login: 'ghost' }, email: 'z@z.com' }, byLogin, byEmail)).toBeNull();
		expect(pickCommitMember(null, byLogin, byEmail)).toBeNull();
	});

	it('isBugLabel matches whole-word bug labels, not substrings', () => {
		expect(isBugLabel(['Bug', 'Critical'])).toBe(true);
		expect(isBugLabel(['bugs'])).toBe(true);
		expect(isBugLabel(['type:bug'])).toBe(true);
		expect(isBugLabel(['kind/bug'])).toBe(true);
		expect(isBugLabel(['enhancement'])).toBe(false);
		expect(isBugLabel(['debug'])).toBe(false); // not a bug label
		expect(isBugLabel(['bugfix'])).toBe(false); // a fix, not a bug report
	});
});

describe('months', () => {
	it('returns N ascending months including the current one', () => {
		const ms = lastNMonths(3, new Date('2026-06-15T00:00:00Z'));
		expect(ms.map(monthKey)).toEqual(['2026-04', '2026-05', '2026-06']);
	});
	it('rolls over year boundaries', () => {
		const ms = lastNMonths(3, new Date('2026-01-10T00:00:00Z'));
		expect(ms.map(monthKey)).toEqual(['2025-11', '2025-12', '2026-01']);
	});
	it('computes the last day of the month', () => {
		expect(monthEnd({ year: 2025, month: 2 })).toBe('2025-02-28');
		expect(monthEnd({ year: 2024, month: 2 })).toBe('2024-02-29');
	});
});

describe('prStatsForMonth', () => {
	it('uses median over merged PRs for add/del/days, median over all for comments/reviews', () => {
		const created = {
			issueCount: 3,
			nodes: [
				{ additions: 10, deletions: 2, merged: true, createdAt: '2026-05-01T00:00:00Z', closedAt: '2026-05-03T00:00:00Z', comments: { totalCount: 1 }, reviews: { totalCount: 2 } },
				{ additions: 30, deletions: 6, merged: true, createdAt: '2026-05-01T00:00:00Z', closedAt: '2026-05-05T00:00:00Z', comments: { totalCount: 3 }, reviews: { totalCount: 4 } },
				{ additions: 999, deletions: 999, merged: false, createdAt: '2026-05-04T00:00:00Z', closedAt: null, comments: { totalCount: 5 }, reviews: { totalCount: 0 } }
			]
		};
		const s = prStatsForMonth(created, 2, 3);
		expect(s).toMatchObject({ created: 3, merged: 2, closed: 3 });
		expect(s.additions).toBe(40); // sum over merged: 10+30
		expect(s.deletions).toBe(8); // sum over merged: 2+6
		expect(s.addPerPr).toBe(20); // median(10,30)
		expect(s.delPerPr).toBe(4); // median(2,6)
		expect(s.daysPerPr).toBe(3); // median(2,4)
		expect(s.commentsPerPr).toBe(3); // median(1,3,5)
		expect(s.reviewsPerPr).toBe(2); // median(2,4,0)
	});
	it('zeros everything when there are no PRs', () => {
		expect(prStatsForMonth({ issueCount: 0, nodes: [] }, 0, 0)).toMatchObject({
			created: 0,
			addPerPr: 0,
			commentsPerPr: 0
		});
	});
});

describe('issueStatsForMonth', () => {
	it('counts bugs and resolution stats from labelled issues', () => {
		const opened = {
			issueCount: 3,
			nodes: [
				{ createdAt: '2026-05-01T00:00:00Z', closedAt: '2026-05-11T00:00:00Z', labels: { nodes: [{ name: 'bug' }] } },
				{ createdAt: '2026-05-01T00:00:00Z', closedAt: null, labels: { nodes: [{ name: 'Bug' }] } },
				{ createdAt: '2026-05-01T00:00:00Z', closedAt: '2026-05-02T00:00:00Z', labels: { nodes: [] } }
			]
		};
		const s = issueStatsForMonth(opened, 1);
		expect(s.opened).toBe(3);
		expect(s.closed).toBe(1);
		expect(s.bugs).toBe(2);
		expect(s.resolutionDays).toBe(10); // only the closed bug
		expect(s.resolutionRate).toBe(50); // 1 of 2 bugs resolved
	});
});

describe('reviewCountsFromNodes', () => {
	const start = Date.parse('2026-05-01T00:00:00Z');
	const end = Date.parse('2026-05-31T23:59:59Z');
	it('counts reviews/comments per reviewer, excludes self, PENDING and out-of-window', () => {
		const prs = [
			{
				author: { login: 'alice' },
				reviews: {
					nodes: [
						{ author: { login: 'bob' }, submittedAt: '2026-05-10T00:00:00Z', state: 'APPROVED' },
						{ author: { login: 'alice' }, submittedAt: '2026-05-10T00:00:00Z', state: 'COMMENTED' }, // self
						{ author: { login: 'bob' }, submittedAt: '2026-05-10T00:00:00Z', state: 'PENDING' }, // pending
						{ author: { login: 'carol' }, submittedAt: '2026-04-10T00:00:00Z', state: 'APPROVED' } // out of window
					]
				},
				comments: {
					nodes: [
						{ author: { login: 'bob' }, createdAt: '2026-05-12T00:00:00Z' },
						{ author: { login: 'stranger' }, createdAt: '2026-05-12T00:00:00Z' }
					]
				}
			}
		];
		const counts = reviewCountsFromNodes(prs, start, end);
		expect(counts.get('bob')).toEqual({ reviews: 1, comments: 1 }); // 1 valid review (pending excluded), 1 comment
		expect(counts.has('alice')).toBe(false); // self-review excluded
		expect(counts.has('carol')).toBe(false); // out of window
		expect(counts.get('stranger')).toEqual({ reviews: 0, comments: 1 }); // every reviewer kept (no Others bucketing here)
	});
});

describe('commitShasForMember', () => {
	const start = Date.parse('2026-05-01T00:00:00Z');
	const end = Date.parse('2026-05-31T23:59:59Z');
	const member = { login: 'alice', name: 'Alice', email: 'a@x.io' };
	it('dedupes by sha across PR + main, matches by login or email, filters PR commits by date', () => {
		const prCommits = [
			{ oid: 'sha1', committedDate: '2026-05-10T00:00:00Z', author: { email: null, user: { login: 'alice' } } },
			{ oid: 'sha1', committedDate: '2026-05-10T00:00:00Z', author: { email: null, user: { login: 'alice' } } }, // dup
			{ oid: 'sha2', committedDate: '2026-04-10T00:00:00Z', author: { email: null, user: { login: 'alice' } } }, // out of window
			{ oid: 'sha3', committedDate: '2026-05-10T00:00:00Z', author: { email: 'a@x.io', user: null } } // email match
		];
		const mainCommits = [
			{ oid: 'sha4', committedDate: '2026-05-15T00:00:00Z', author: { email: null, user: { login: 'alice' } } },
			{ oid: 'sha5', committedDate: '2026-05-15T00:00:00Z', author: { email: null, user: { login: 'bob' } } } // not alice
		];
		const shas = commitShasForMember(prCommits, mainCommits, member, start, end);
		expect([...shas].sort()).toEqual(['sha1', 'sha3', 'sha4']);
	});

	it('skips commits with a null author instead of crashing', () => {
		const prCommits = [
			{ oid: 'sha1', committedDate: '2026-05-10T00:00:00Z', author: null as unknown as { email: string | null; user: { login: string } | null } },
			{ oid: 'sha2', committedDate: '2026-05-10T00:00:00Z', author: { email: null, user: { login: 'alice' } } }
		];
		const shas = commitShasForMember(prCommits, [], member, start, end);
		expect([...shas]).toEqual(['sha2']);
	});
});
