import { json, error } from '@sveltejs/kit';
import { hasDb } from '$lib/server/db';
import { updateUserTeam, deleteUserTeam } from '$lib/server/store/teams';
import { parseTeamInput } from '$lib/server/teamInput';
import { getAppSettings } from '$lib/server/app-config';
import { audit } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ locals, request, params }) => {
	if (!hasDb()) throw error(501, 'Team persistence is not configured');
	let input;
	try {
		input = parseTeamInput(await request.json().catch(() => ({})), await getAppSettings());
	} catch (e) {
		throw error(400, (e as Error).message);
	}
	const team = await updateUserTeam(locals.user.sub, params.id, input);
	if (!team) throw error(404, 'Team not found');
	await audit(locals.user.sub, 'team.update', { id: team.id, name: team.name });
	return json({ team });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!hasDb()) throw error(501, 'Team persistence is not configured');
	const ok = await deleteUserTeam(locals.user.sub, params.id);
	if (!ok) throw error(404, 'Team not found');
	await audit(locals.user.sub, 'team.delete', { id: params.id });
	return json({ ok: true });
};
