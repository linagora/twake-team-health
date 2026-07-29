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
		// The subject must be a member of the submitted roster, which parseSelection
		// has already shape-validated. This is a sanitization guard, not an
		// authorization one: the caller supplies the roster too, so it constrains
		// the login's FORM, not who may be asked about. Authorization here is the
		// repo allowlist that parseSelection applies — the report only ever reads
		// facts from repos in ALLOWED_ORGS, and the login merely filters those.
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
