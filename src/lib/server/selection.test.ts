import { describe, it, expect } from 'vitest';
import { parseSelection, parseRepoSelection } from './selection';

const repos = (n: number) => Array.from({ length: n }, (_, i) => ({ owner: 'linagora', repo: `r${i}` }));

describe('selection repo limit', () => {
	it('keeps every repo of a team up to the limit', () => {
		expect(parseSelection({ repos: repos(73) }).repos).toHaveLength(73);
		expect(parseRepoSelection({ repos: repos(73) })).toHaveLength(73);
	});

	it('rejects an over-limit selection instead of silently dropping the tail', () => {
		expect(() => parseSelection({ repos: repos(101) })).toThrow(/100/);
		expect(() => parseRepoSelection({ repos: repos(101) })).toThrow(/100/);
	});
});
