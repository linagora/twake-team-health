import { describe, it, expect } from 'vitest';
import { computeAwards } from './awards';
import type { MetricsResult, Member } from './server/github/types';

const members: Member[] = [
	{ login: 'alice', name: 'Alice' },
	{ login: 'Bob', name: 'Bob' } // capitalized login to exercise case-insensitive matching
];

const metrics = (over: Partial<MetricsResult> = {}): MetricsResult => ({
	repos: [],
	authors: [
		{ author: 'alice', month: '2026-06', commits: 10 },
		{ author: 'bob', month: '2026-06', commits: 5 },
		{ author: 'outsider', month: '2026-06', commits: 99 }
	],
	mergedByAuthor: [
		{ author: 'bob', month: '2026-06', mergedPRs: 8 },
		{ author: 'alice', month: '2026-06', mergedPRs: 2 }
	],
	reviewActivity: [
		{ author: 'alice', reviews: 3, comments: 1 },
		{ author: 'bob', reviews: 1, comments: 9 }
	],
	issuesByMonth: [],
	commitsByAuthorRepo: [
		{ author: 'alice', repo: 'o/a', commits: 6 },
		{ author: 'alice', repo: 'o/b', commits: 4 },
		{ author: 'bob', repo: 'o/a', commits: 5 }
	],
	linesByAuthor: [
		{ author: 'alice', additions: 100, deletions: 50 },
		{ author: 'bob', additions: 10, deletions: 5 }
	],
	workPattern: [],
	generatedAt: 0,
	...over
});

const by = (a: ReturnType<typeof computeAwards>, key: string) => a.find((x) => x.key === key);

describe('computeAwards', () => {
	const awards = computeAwards(metrics(), members);

	it('picks the right winner per stat and excludes non-members', () => {
		expect(by(awards, 'commits')?.name).toBe('Alice');
		expect(by(awards, 'commits')?.stat).toBe('10 commits');
		expect(by(awards, 'merged')?.name).toBe('Bob');
		expect(by(awards, 'reviews')?.name).toBe('Alice');
		expect(by(awards, 'comments')?.name).toBe('Bob');
		expect(by(awards, 'lines')?.name).toBe('Alice'); // 150 vs 15
		expect(by(awards, 'breadth')?.name).toBe('Alice'); // 2 repos vs 1
		expect(by(awards, 'breadth')?.stat).toBe('2 repos');
	});

	it('matches logins case-insensitively (Bob vs bob)', () => {
		expect(by(awards, 'merged')?.login).toBe('Bob');
	});

	it('omits an award when nobody scored', () => {
		const a = computeAwards(metrics({ reviewActivity: [] }), members);
		expect(by(a, 'reviews')).toBeUndefined();
		expect(by(a, 'comments')).toBeUndefined();
	});
});
