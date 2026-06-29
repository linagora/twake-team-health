import { defaultTeams } from '$lib/server/preset';
import { allowedOrgs } from '$lib/server/discovery';
import { AUTH_DISABLED, isAdmin } from '$lib/server/auth';
import { hasDb } from '$lib/server/db';
import { getAppSettings } from '$lib/server/app-config';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	const settings = await getAppSettings();
	return {
		defaultTeams: defaultTeams(),
		allowedOrgs: allowedOrgs(),
		defaults: { months: settings.defaultMonths, memberMonths: settings.defaultMemberMonths },
		global: { repos: settings.globalRepos, months: settings.globalMonths },
		signals: settings.signals,
		orgName: settings.orgName,
		user: { name: locals.user?.name ?? '', email: locals.user?.email ?? '' },
		authEnabled: !AUTH_DISABLED,
		teamsPersisted: hasDb(),
		isAdmin: isAdmin(locals.user)
	};
};
