import { json, error } from '@sveltejs/kit';
import { hasDb } from '$lib/server/db';
import { listUserTeams, createUserTeam } from '$lib/server/store/teams';
import { parseTeamInput } from '$lib/server/teamInput';
import { getAppSettings } from '$lib/server/app-config';
import { audit } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!hasDb()) return json({ teams: [] });
	return json({ teams: await listUserTeams(locals.user.sub) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!hasDb()) throw error(501, 'Team persistence is not configured');
	let input;
	try {
		input = parseTeamInput(await request.json().catch(() => ({})), await getAppSettings());
	} catch (e) {
		throw error(400, (e as Error).message);
	}
	const team = await createUserTeam(locals.user.sub, input.name, input.members, input.repos, input.tz);
	await audit(locals.user.sub, 'team.create', { id: team.id, name: team.name });
	return json({ team }, { status: 201 });
};
