// Playful "MVP" superlatives for the Overview: the standout member for each of a
// handful of engineering stats. Pure and unit-tested. Two entry points share the
// same award definitions: `computeAwards` (calendar-month metrics) and
// `computeAwardsFromRecent` (rolling trailing-30d snapshot, the default).
import type { MetricsResult, Member, RecentMember } from './server/github/types';
import { fmtNum } from './utils';

export type Award = {
	key: string;
	title: string; // the award name, e.g. "The Machine"
	tagline: string; // what it measures, e.g. "Most commits"
	login: string;
	name: string;
	stat: string; // formatted winner value, e.g. "1,059 commits"
};

const lc = (s: string) => s.toLowerCase();

type StatMaps = {
	commits: Map<string, number>;
	merged: Map<string, number>;
	reviews: Map<string, number>;
	comments: Map<string, number>;
	lines: Map<string, number>;
	breadth: Map<string, number>;
};

const emptyMaps = (): StatMaps => ({
	commits: new Map(),
	merged: new Map(),
	reviews: new Map(),
	comments: new Map(),
	lines: new Map(),
	breadth: new Map(),
});

const AWARD_DEFS: { key: keyof StatMaps; title: string; tagline: string; unit: string }[] = [
	{ key: 'commits', title: 'The Machine', tagline: 'Most commits', unit: 'commits' },
	{ key: 'merged', title: 'The Closer', tagline: 'Most PRs merged', unit: 'merged' },
	{ key: 'reviews', title: 'The Gatekeeper', tagline: 'Most reviews', unit: 'reviews' },
	{ key: 'comments', title: 'The Diplomat', tagline: 'Most PR comments', unit: 'comments' },
	{ key: 'lines', title: 'The Heavyweight', tagline: 'Most lines changed', unit: 'lines' },
	{ key: 'breadth', title: 'The Explorer', tagline: 'Most repos touched', unit: 'repos' }
];

/** Pick each award's winner (highest positive value) and format it. Awards with
 * no winner (nobody scored above zero) are omitted. */
function buildAwards(memberByLc: Map<string, Member>, maps: StatMaps): Award[] {
	const winner = (map: Map<string, number>): { login: string; value: number } | null => {
		let best: { login: string; value: number } | null = null;
		for (const [k, v] of map) if (v > 0 && (!best || v > best.value)) best = { login: k, value: v };
		return best;
	};
	const out: Award[] = [];
	for (const d of AWARD_DEFS) {
		const w = winner(maps[d.key]);
		if (!w) continue;
		const m = memberByLc.get(w.login)!;
		out.push({
			key: d.key,
			title: d.title,
			tagline: d.tagline,
			login: m.login,
			name: m.name,
			stat: `${fmtNum(w.value)} ${d.unit}`
		});
	}
	return out;
}

/** Standouts from the calendar-month metrics (used as a fallback when a
 * stale-cached result has no rolling snapshot). */
export function computeAwards(metrics: MetricsResult, members: Member[]): Award[] {
	const memberByLc = new Map(members.map((m) => [lc(m.login), m]));
	const maps = emptyMaps();
	const bump = (map: Map<string, number>, login: string, n: number) => {
		const k = lc(login);
		if (!memberByLc.has(k)) return;
		map.set(k, (map.get(k) ?? 0) + n);
	};
	for (const a of metrics.authors) bump(maps.commits, a.author, a.commits);
	for (const a of metrics.mergedByAuthor) bump(maps.merged, a.author, a.mergedPRs);
	for (const r of metrics.reviewActivity) {
		bump(maps.reviews, r.author, r.reviews);
		bump(maps.comments, r.author, r.comments);
	}
	for (const l of metrics.linesByAuthor) bump(maps.lines, l.author, l.additions + l.deletions);
	// Breadth: how many distinct repos a member committed to.
	const repoSets = new Map<string, Set<string>>();
	for (const c of metrics.commitsByAuthorRepo) {
		const k = lc(c.author);
		if (c.commits <= 0 || !memberByLc.has(k)) continue;
		(repoSets.get(k) ?? repoSets.set(k, new Set()).get(k)!).add(c.repo);
	}
	for (const [k, s] of repoSets) maps.breadth.set(k, s.size);
	return buildAwards(memberByLc, maps);
}

/** Standouts from the rolling trailing-30d snapshot: the default, so the trophies
 * reflect the last 30 days rather than a 12-month window. */
export function computeAwardsFromRecent(recent: RecentMember[], members: Member[]): Award[] {
	const memberByLc = new Map(members.map((m) => [lc(m.login), m]));
	const maps = emptyMaps();
	for (const r of recent) {
		const k = lc(r.login);
		if (!memberByLc.has(k)) continue;
		if (r.commits > 0) maps.commits.set(k, r.commits);
		if (r.mergedPrs > 0) maps.merged.set(k, r.mergedPrs);
		if (r.reviews > 0) maps.reviews.set(k, r.reviews);
		if (r.comments > 0) maps.comments.set(k, r.comments);
		const lines = r.additions + r.deletions;
		if (lines > 0) maps.lines.set(k, lines);
		if (r.repos > 0) maps.breadth.set(k, r.repos);
	}
	return buildAwards(memberByLc, maps);
}
