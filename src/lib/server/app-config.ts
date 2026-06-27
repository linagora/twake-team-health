// App-wide settings: admin-editable overrides (DB) layered over the env defaults.
// An empty/missing row leaves behavior identical to a pure-env setup. ALLOWED_ORGS
// is deliberately NOT overridable here: it's the authorization boundary for the
// privileged token and must stay env-controlled.
import { env } from '$env/dynamic/private';
import { eq } from 'drizzle-orm';
import { db, hasDb } from './db';
import { appConfig } from './db/schema';
import { parseRepos } from './validate';
import { allowedOrgs } from './discovery';
import { DEFAULT_MONTHS, DEFAULT_MEMBER_MONTHS, GLOBAL_MONTHS, defaultGlobalRepos } from './preset';
import { DEFAULT_TARGETS, type Targets } from '$lib/signals';
import { setMaxConcurrency } from './github/limits';
import type { Repo } from './github/types';

export type AppSettings = {
	globalRepos: Repo[];
	globalMonths: number;
	defaultMonths: number;
	defaultMemberMonths: number;
	// Health thresholds: Signals targets + Attention staleness windows (days).
	signals: Targets;
	attentionStaleDays: number;
	attentionAgingDays: number;
	// Max in-flight GitHub GraphQL calls (lower = gentler on the rate limit).
	fetchConcurrency: number;
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
		defaultMemberMonths: DEFAULT_MEMBER_MONTHS,
		signals: DEFAULT_TARGETS,
		attentionStaleDays: Number(env.ATTENTION_STALE_DAYS ?? 7),
		attentionAgingDays: Number(env.ATTENTION_AGING_DAYS ?? 14),
		fetchConcurrency: Number(env.GITHUB_MAX_CONCURRENCY) || 8
	};
}

const months = (n: unknown): number | undefined => {
	const v = Number(n);
	return Number.isInteger(v) && v >= 1 && v <= 36 ? v : undefined;
};

const days = (n: unknown): number | undefined => {
	const v = Number(n);
	return Number.isInteger(v) && v >= 1 && v <= 365 ? v : undefined;
};

// Merge any valid numeric Targets fields over the defaults; unknown/invalid drop.
function sanitizeTargets(o: unknown): Targets | undefined {
	if (!o || typeof o !== 'object') return undefined;
	const s = o as Record<string, unknown>;
	const merged = { ...DEFAULT_TARGETS };
	let any = false;
	for (const k of Object.keys(DEFAULT_TARGETS) as (keyof Targets)[]) {
		const v = Number(s[k]);
		if (Number.isFinite(v) && v >= 0) {
			merged[k] = v;
			any = true;
		}
	}
	return any ? merged : undefined;
}

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
	const signals = sanitizeTargets(o.signals);
	if (signals) out.signals = signals;
	const sd = days(o.attentionStaleDays);
	const ad = days(o.attentionAgingDays);
	if (sd) out.attentionStaleDays = sd;
	if (ad) out.attentionAgingDays = ad;
	const fc = Number(o.fetchConcurrency);
	if (Number.isInteger(fc) && fc >= 1 && fc <= 32) out.fetchConcurrency = fc;
	return out;
}

/** Effective settings: stored overrides merged over env defaults (cached).
 * A failed DB read returns env defaults WITHOUT caching, so a transient outage
 * can't mask a recovered DB (and freshly-saved overrides) for the full TTL. */
export async function getAppSettings(): Promise<AppSettings> {
	if (cache && cache.expires > Date.now()) {
		setMaxConcurrency(cache.value.fetchConcurrency);
		return cache.value;
	}
	const base = envSettings();
	let value = base;
	if (hasDb()) {
		try {
			const [row] = await db().select().from(appConfig).where(eq(appConfig.id, CONFIG_ID));
			value = row?.value ? { ...base, ...sanitize(row.value as Record<string, unknown>) } : base;
			cache = { value, expires: Date.now() + TTL_MS };
		} catch {
			value = base; // not cached: retry on the next call
		}
	} else {
		cache = { value: base, expires: Date.now() + TTL_MS };
	}
	// Push the effective cap to the GraphQL client so it takes effect at runtime.
	setMaxConcurrency(value.fetchConcurrency);
	return value;
}

/** Persist admin overrides (validated). Returns the new effective settings. */
export async function setAppSettings(patch: Record<string, unknown>): Promise<AppSettings> {
	if (!hasDb()) throw new Error('persistence is not configured');
	// Merge onto the existing stored overrides so a partial PUT doesn't drop
	// previously-saved settings.
	const [row] = await db().select().from(appConfig).where(eq(appConfig.id, CONFIG_ID));
	const existing = (row?.value as Record<string, unknown>) ?? {};
	const merged = sanitize({ ...existing, ...patch });
	await db()
		.insert(appConfig)
		.values({ id: CONFIG_ID, value: merged })
		.onConflictDoUpdate({ target: appConfig.id, set: { value: merged, updatedAt: new Date() } });
	cache = null;
	return getAppSettings();
}
