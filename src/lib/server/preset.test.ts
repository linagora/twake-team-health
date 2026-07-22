import { describe, it, expect } from 'vitest';
import { applyDefaultTeamOverrides } from './preset';
import type { Team } from '$lib/client/selection';
import type { DefaultTeamOverride } from './store/default-teams';

const presets: Team[] = [
	{ id: 'builtin:0', name: 'Platform', members: [{ login: 'a', name: 'A' }], repos: [{ owner: 'o', repo: 'p' }], builtin: true },
	{ id: 'builtin:1', name: 'Web', members: [], repos: [{ owner: 'o', repo: 'w' }], builtin: true }
];

const override = (o: Partial<DefaultTeamOverride> & { builtinId: string }): DefaultTeamOverride => ({
	name: 'x',
	members: [],
	repos: [{ owner: 'o', repo: 'r' }],
	...o
});

describe('applyDefaultTeamOverrides', () => {
	it('returns presets unchanged when there are no overrides', () => {
		expect(applyDefaultTeamOverrides(presets, new Map())).toEqual(presets);
	});

	it('replaces a matching preset with the override and flags it overridden', () => {
		const o = override({ builtinId: 'builtin:0', name: 'Renamed', members: [{ login: 'z', name: 'Z' }], repos: [{ owner: 'o', repo: 'q' }], tz: 'Europe/Paris' });
		const [first, second] = applyDefaultTeamOverrides(presets, new Map([['builtin:0', o]]));
		expect(first).toEqual({ id: 'builtin:0', name: 'Renamed', members: [{ login: 'z', name: 'Z' }], repos: [{ owner: 'o', repo: 'q' }], tz: 'Europe/Paris', builtin: true, overridden: true });
		// A preset without an override is left exactly as configured.
		expect(second).toEqual(presets[1]);
	});

	it('omits tz when the override has none', () => {
		const [first] = applyDefaultTeamOverrides(presets, new Map([['builtin:0', override({ builtinId: 'builtin:0' })]]));
		expect(first).not.toHaveProperty('tz');
	});

	it('ignores overrides that do not match any preset (no phantom teams)', () => {
		const out = applyDefaultTeamOverrides(presets, new Map([['builtin:9', override({ builtinId: 'builtin:9' })]]));
		expect(out).toEqual(presets);
	});
});
