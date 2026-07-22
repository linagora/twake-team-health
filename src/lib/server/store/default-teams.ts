import { eq } from 'drizzle-orm';
import { db } from '../db';
import { defaultTeamOverride } from '../db/schema';
import type { Member, Repo } from '../github/types';

// Global overrides of the env-configured default teams. Unlike the per-user
// `team` store these rows are ownerless and shared: any signed-in user may edit a
// default team in place and everyone sees the result. Keyed by the preset's
// built-in id; an absent row means "use the env DEFAULT_TEAMS preset".
export type DefaultTeamOverride = { builtinId: string; name: string; members: Member[]; repos: Repo[]; tz?: string };

const toRow = (r: typeof defaultTeamOverride.$inferSelect): DefaultTeamOverride => ({
	builtinId: r.builtinId,
	name: r.name,
	members: r.members,
	repos: r.repos,
	...(r.tz ? { tz: r.tz } : {})
});

/** All stored overrides, keyed by built-in id, for overlaying onto env presets. */
export async function listDefaultTeamOverrides(): Promise<Map<string, DefaultTeamOverride>> {
	const rows = await db().select().from(defaultTeamOverride);
	return new Map(rows.map((r) => [r.builtinId, toRow(r)]));
}

export async function upsertDefaultTeamOverride(
	builtinId: string,
	editorSub: string,
	patch: { name: string; members: Member[]; repos: Repo[]; tz?: string }
): Promise<DefaultTeamOverride> {
	// tz is explicitly nulled when absent so clearing a team's timezone persists.
	const set = { name: patch.name, members: patch.members, repos: patch.repos, tz: patch.tz ?? null, lastEditedBy: editorSub, updatedAt: new Date() };
	const [r] = await db()
		.insert(defaultTeamOverride)
		.values({ builtinId, ...set })
		.onConflictDoUpdate({ target: defaultTeamOverride.builtinId, set })
		.returning();
	return toRow(r);
}

/** Remove an override, resetting the default team to its env preset. */
export async function deleteDefaultTeamOverride(builtinId: string): Promise<boolean> {
	const r = await db()
		.delete(defaultTeamOverride)
		.where(eq(defaultTeamOverride.builtinId, builtinId))
		.returning({ builtinId: defaultTeamOverride.builtinId });
	return r.length > 0;
}
