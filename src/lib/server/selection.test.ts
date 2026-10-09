import { describe, it, expect } from 'vitest';
import { parseSelection, parseRepoSelection } from './selection';
import { parseTeamInput } from './teamInput';

const repos = (n: number) => Array.from({ length: n }, (_, i) => ({ owner: 'linagora', repo: `r${i}` }));
const members = (n: number) => Array.from({ length: n }, (_, i) => ({ login: `u${i}` }));
const limits = { maxRepos: 50, maxMembers: 10 };

describe('configured list limits', () => {
	it('keeps every repo and member up to the limit', () => {
		const s = parseSelection({ repos: repos(50), members: members(10) }, limits);
		expect(s.repos).toHaveLength(50);
		expect(s.members).toHaveLength(10);
		expect(parseRepoSelection({ repos: repos(50) }, limits.maxRepos)).toHaveLength(50);
		expect(parseTeamInput({ name: 't', repos: repos(50), members: members(10) }, limits).repos).toHaveLength(50);
	});

	it('rejects an over-limit list instead of silently dropping the tail', () => {
		expect(() => parseSelection({ repos: repos(51) }, limits)).toThrow(/50 repositories/);
		expect(() => parseSelection({ repos: repos(1), members: members(11) }, limits)).toThrow(/10 members/);
		expect(() => parseRepoSelection({ repos: repos(51) }, limits.maxRepos)).toThrow(/50 repositories/);
		expect(() => parseTeamInput({ name: 't', repos: repos(51) }, limits)).toThrow(/50 repositories/);
		expect(() => parseTeamInput({ name: 't', repos: repos(1), members: members(11) }, limits)).toThrow(/10 members/);
	});
});
