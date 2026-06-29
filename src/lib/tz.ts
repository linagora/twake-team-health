// Timezone helpers shared by client and server. Burnout/recovery classify commits
// in each member's local time; the zone comes from a per-member override or the
// team default (resolved here), validated against the platform's IANA database.
import type { Member } from './server/github/types';

/** True if `tz` is an IANA zone the runtime recognizes (e.g. "Asia/Ho_Chi_Minh"). */
export function isValidTimeZone(tz: unknown): tz is string {
	if (typeof tz !== 'string' || !tz) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** All IANA zones the runtime supports, for a picker. Empty if unsupported. */
export function commonTimeZones(): string[] {
	try {
		return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
	} catch {
		return [];
	}
}

/** Resolve each member's effective zone: their own override, else the team default.
 * Only sets `tz` when a valid zone applies, so members fall back to the commit's
 * embedded offset otherwise. Pure; safe to call on the client and in the warm job. */
export function withTeamTz(members: Member[], teamTz?: string): Member[] {
	const fallback = isValidTimeZone(teamTz) ? teamTz : undefined;
	return members.map((m) => ({ ...m, tz: isValidTimeZone(m.tz) ? m.tz : fallback }));
}
