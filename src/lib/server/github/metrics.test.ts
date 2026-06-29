import { describe, it, expect } from 'vitest';
import {
	prStatsForMonth,
	issueStatsForMonth,
	reviewCountsFromNodes,
	pickCommitMember,
	commitLocalTime,
	classifyCommitTime,
	weekIdOf
} from './metrics';
import { median, std, isBugLabel, makeBugMatcher } from './stats';
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

	it('makeBugMatcher uses a configured list (exact, case-insensitive), else the heuristic', () => {
		const m = makeBugMatcher(['defect', 'Type: Bug']);
		expect(m(['defect'])).toBe(true);
		expect(m(['type: bug'])).toBe(true); // case-insensitive
		expect(m(['bug'])).toBe(false); // not in the configured list
		// Empty config falls back to the default heuristic.
		expect(makeBugMatcher([])(['bug'])).toBe(true);
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
	it('computes volume/lead-time/engagement over the merged cohort; created and closed are counts', () => {
		const merged = {
			issueCount: 2,
			nodes: [
				{ additions: 10, deletions: 2, createdAt: '2026-05-01T00:00:00Z', mergedAt: '2026-05-03T00:00:00Z', comments: { totalCount: 1 }, reviews: { totalCount: 2 } },
				{ additions: 30, deletions: 6, createdAt: '2026-05-01T00:00:00Z', mergedAt: '2026-05-05T00:00:00Z', comments: { totalCount: 3 }, reviews: { totalCount: 4 } }
			]
		};
		const s = prStatsForMonth(merged, 3, 4); // createdCount=3, closedCount=4
		expect(s).toMatchObject({ created: 3, merged: 2, closed: 4 });
		expect(s.additions).toBe(40); // sum over merged: 10+30
		expect(s.deletions).toBe(8); // sum over merged: 2+6
		expect(s.addPerPr).toBe(20); // median(10,30)
		expect(s.delPerPr).toBe(4); // median(2,6)
		expect(s.daysPerPr).toBe(3); // median(2,4) days (mergedAt - createdAt)
		expect(s.commentsPerPr).toBe(2); // median(1,3)
		expect(s.reviewsPerPr).toBe(3); // median(2,4)
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

	it('skips null nodes and missing labels from partial 200s', () => {
		// GitHub returns null nodes (and can null `labels`) for issues a token
		// cannot resolve, e.g. a repo it lacks access to. Must not throw.
		const opened = {
			issueCount: 2,
			nodes: [
				null,
				{ createdAt: '2026-05-01T00:00:00Z', closedAt: null, labels: null },
				{ createdAt: '2026-05-01T00:00:00Z', closedAt: '2026-05-03T00:00:00Z', labels: { nodes: [{ name: 'bug' }] } }
			]
		} as unknown as Parameters<typeof issueStatsForMonth>[0];
		const s = issueStatsForMonth(opened, 0);
		expect(s.opened).toBe(2);
		expect(s.bugs).toBe(1);
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

describe('pickCommitMember', () => {
	const byLogin = new Map([['alice', 'alice']]);
	const byEmail = new Map([['a@x.io', 'alice']]);
	it('attributes a linked GitHub user to the matching member', () => {
		expect(pickCommitMember({ email: null, user: { login: 'Alice' } }, byLogin, byEmail)).toBe('alice');
	});
	it('falls back to email only when there is no linked user', () => {
		expect(pickCommitMember({ email: 'a@x.io', user: null }, byLogin, byEmail)).toBe('alice');
	});
	it('does not steal a non-member commit via a matching email when a user is linked', () => {
		// Linked GitHub user is non-member: authoritative, so no email fallback.
		expect(pickCommitMember({ email: 'a@x.io', user: { login: 'alice-alt' } }, byLogin, byEmail)).toBeNull();
	});
	it('returns null for a null author', () => {
		expect(pickCommitMember(null, byLogin, byEmail)).toBeNull();
	});
});

describe('commitLocalTime / classifyCommitTime', () => {
	it('reads the committer-local wall clock from the embedded offset, not the server zone', () => {
		// 22:45 in +02:00 is 20:45 UTC, but locally it is a late-night Friday commit.
		expect(commitLocalTime('2026-06-12T22:45:00+02:00')).toEqual({ dow: 5, hour: 22 });
		// Same UTC instant tagged -05:00 is 15:45 local: an ordinary weekday afternoon.
		expect(commitLocalTime('2026-06-12T15:45:00-05:00')).toEqual({ dow: 5, hour: 15 });
	});

	it('flags weekend commits in local time', () => {
		// Sunday 14:00 in Tokyo (+09:00).
		expect(classifyCommitTime('2026-06-14T14:00:00+09:00')).toEqual({ weekend: true, lateNight: false });
	});

	it('flags late-night commits (22:00-05:59 local)', () => {
		expect(classifyCommitTime('2026-06-10T02:30:00+01:00')).toEqual({ weekend: false, lateNight: true });
		expect(classifyCommitTime('2026-06-10T22:00:00+01:00')).toEqual({ weekend: false, lateNight: true });
		expect(classifyCommitTime('2026-06-10T09:00:00+01:00')).toEqual({ weekend: false, lateNight: false });
	});

	it('weekIdOf gives Monday-aligned buckets: a week off is a real gap', () => {
		// 2026-06-01 is a Monday, 2026-06-07 the Sunday that ends the same week.
		const mon = weekIdOf('2026-06-01T09:00:00Z')!;
		expect(weekIdOf('2026-06-07T23:00:00Z')).toBe(mon); // same Mon-Sun week -> one bucket
		expect(weekIdOf('2026-06-08T00:00:00Z')).toBe(mon + 1); // next Monday -> next bucket
		expect(weekIdOf('2026-05-31T23:00:00Z')).toBe(mon - 1); // prior Sunday -> prior bucket
		expect(weekIdOf('nope')).toBeNull();
	});

	it('defaults to UTC for a Z-suffixed or zone-less timestamp and returns false buckets for garbage', () => {
		expect(commitLocalTime('2026-06-13T23:00:00Z')).toEqual({ dow: 6, hour: 23 });
		// No zone designator: pinned to UTC (not the server's locale) for determinism.
		expect(commitLocalTime('2026-06-13T23:00:00')).toEqual({ dow: 6, hour: 23 });
		expect(classifyCommitTime('not-a-date')).toEqual({ weekend: false, lateNight: false });
	});
});
