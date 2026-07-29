import { json, error } from '@sveltejs/kit';
import { getPerson } from '$lib/server/person-cache';
import { parseSelection } from '$lib/server/selection';
import { throwUpstreamError } from '$lib/server/api-errors';
import { audit } from '$lib/server/store/audit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	let selection;
	let login: string;
	try {
		const body = await request.json().catch(() => ({}));
		selection = parseSelection(body);
		const raw = (body as { login?: unknown }).login;
		// The subject must be a member of the submitted (already validated) roster.
		// That is the sanitization guard and the authorization guard at once: no
		// arbitrary login can be aimed at the privileged token through this route.
		const match = selection.members.find(
			(m) => typeof raw === 'string' && m.login.toLowerCase() === raw.toLowerCase(),
		);
		if (!match) throw new Error('login must be a member of the submitted selection');
		login = match.login;
	} catch (e) {
		throw error(400, (e as Error).message);
	}
	try {
		const result = await getPerson(selection, login);
		await audit(locals.user.sub, 'person.view', {
			login,
			repos: selection.repos.length,
			months: selection.memberMonths,
		});
		return json(result);
	} catch (e) {
		throwUpstreamError(e, 'api/person');
	}
};
