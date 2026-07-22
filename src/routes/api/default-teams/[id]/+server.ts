import { json, error } from '@sveltejs/kit';
import { hasDb } from '$lib/server/db';
import { defaultTeams, clearDefaultTeamsCache } from '$lib/server/preset';
import { upsertDefaultTeamOverride, deleteDefaultTeamOverride } from '$lib/server/store/default-teams';
import { parseTeamInput } from '$lib/server/teamInput';
import { audit } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

// Editing a default (built-in) team writes a GLOBAL override shared with every
// user, keyed by the preset's built-in id. Any signed-in user may edit; deleting
// the override resets the team to its env DEFAULT_TEAMS preset. The id must name a
// real preset so a client can't invent overrides for teams that don't exist.
const preset = (id: string) => defaultTeams().find((t) => t.id === id);

export const PUT: RequestHandler = async ({ locals, request, params }) => {
	if (!hasDb()) throw error(501, 'Team persistence is not configured');
	if (!preset(params.id)) throw error(404, 'Unknown default team');
	let input;
	try {
		input = parseTeamInput(await request.json().catch(() => ({})));
	} catch (e) {
		throw error(400, (e as Error).message);
	}
	await upsertDefaultTeamOverride(params.id, locals.user.sub, input);
	clearDefaultTeamsCache();
	await audit(locals.user.sub, 'defaultTeam.update', { id: params.id, name: input.name });
	return json({ team: { id: params.id, ...input, builtin: true, overridden: true } });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!hasDb()) throw error(501, 'Team persistence is not configured');
	const p = preset(params.id);
	if (!p) throw error(404, 'Unknown default team');
	await deleteDefaultTeamOverride(params.id);
	clearDefaultTeamsCache();
	await audit(locals.user.sub, 'defaultTeam.reset', { id: params.id });
	// Return the env preset so the client can restore it in place without a reload.
	return json({ team: p });
};
