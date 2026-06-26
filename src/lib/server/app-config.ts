// App-wide settings: admin-editable overrides (DB) layered over the env defaults.
// An empty/missing row leaves behavior identical to a pure-env setup. ALLOWED_ORGS
// is deliberately NOT overridable here: it's the authorization boundary for the
// privileged token and must stay env-controlled.
import { eq } from 'drizzle-orm';
import { db, hasDb } from './db';
import { appConfig } from './db/schema';
import { parseRepos } from './validate';
import { allowedOrgs } from './discovery';
import { DEFAULT_MONTHS, DEFAULT_MEMBER_MONTHS, GLOBAL_MONTHS, defaultGlobalRepos } from './preset';
import type { Repo } from './github/types';

export type AppSettings = {
	globalRepos: Repo[];
	globalMonths: number;
	defaultMonths: number;
	defaultMemberMonths: number;
};

const CONFIG_ID = 'app';
const MAX_GLOBAL_REPOS = 100;
const TTL_MS = 60_000;
let cache: { value: AppSettings; expires: number } | null = null;

function envSettings(): AppSettings {
	return {
		globalRepos: defaultGlobalRepos(),
		globalMonths: GLOBAL_MONTHS,
		defaultMonths: DEFAULT_MONTHS,
		defaultMemberMonths: DEFAULT_MEMBER_MONTHS
	};
}

const months = (n: unknown): number | undefined => {
	const v = Number(n);
	return Number.isInteger(v) && v >= 1 && v <= 36 ? v : undefined;
};

/** Normalize an untrusted overrides object: repos are allowlist-validated and
 * windows clamped; invalid/unknown fields are dropped. */
function sanitize(o: Record<string, unknown>): Partial<AppSettings> {
	const out: Partial<AppSettings> = {};
	if (Array.isArray(o.globalRepos)) {
		const repos = parseRepos(o.globalRepos, MAX_GLOBAL_REPOS, allowedOrgs());
		if (repos.length) out.globalRepos = repos;
	}
	const gm = months(o.globalMonths);
	const dm = months(o.defaultMonths);
	const mm = months(o.defaultMemberMonths);
	if (gm) out.globalMonths = gm;
	if (dm) out.defaultMonths = dm;
	if (mm) out.defaultMemberMonths = mm;
	return out;
}

/** Effective settings: stored overrides merged over env defaults (cached).
 * A failed DB read returns env defaults WITHOUT caching, so a transient outage
 * can't mask a recovered DB (and freshly-saved overrides) for the full TTL. */
export async function getAppSettings(): Promise<AppSettings> {
	if (cache && cache.expires > Date.now()) return cache.value;
	const base = envSettings();
	if (!hasDb()) {
		cache = { value: base, expires: Date.now() + TTL_MS };
		return base;
	}
	try {
		const [row] = await db().select().from(appConfig).where(eq(appConfig.id, CONFIG_ID));
		const value = row?.value ? { ...base, ...sanitize(row.value as Record<string, unknown>) } : base;
		cache = { value, expires: Date.now() + TTL_MS };
		return value;
	} catch {
		return base; // not cached: retry on the next call
	}
}

/** Persist admin overrides (validated). Returns the new effective settings. */
export async function setAppSettings(patch: Record<string, unknown>): Promise<AppSettings> {
	if (!hasDb()) throw new Error('persistence is not configured');
	const clean = sanitize(patch);
	await db()
		.insert(appConfig)
		.values({ id: CONFIG_ID, value: clean })
		.onConflictDoUpdate({ target: appConfig.id, set: { value: clean, updatedAt: new Date() } });
	cache = null;
	return getAppSettings();
}
