// Per-person report: one member's authoring, reviewing and collaboration, over
// the same window and the same month buckets the team report uses.
//
// It aggregates the fact store at read time and fetches nothing of its own, so a
// roster edit, a timezone change or a different window is retroactive. Crucially
// it reuses the team report's own primitives — `resolveReportShape` for the
// buckets, `memberMaps`/`pickCommitMember` for attribution — so the profile
// cannot drift from the overview: the same commit is credited to the same person
// in both, by construction rather than by two implementations agreeing.
//
// Window semantics match the rest of the app: everything is scoped to the
// window, including the review events behind the latency medians. A review left
// before the window on a PR still open inside it is not counted, the same way
// the flow report treats its own window.
import { graphql, type GraphQL } from './github/client';
import { monthKey, monthStartMs, monthEndMs, type Month } from './github/months';
import { median, round } from './github/stats';
import { pickCommitMember } from './github/metrics';
import { memberMaps, commitAuthor } from './store/aggregate';
import { resolveReportShape } from './report';
import { ensureFactsSynced, fetchFactBundleLive } from './sync';
import { getAppSettings } from './app-config';
import { dayOf, dayStartMs } from './days';
import * as store from './store';
import { hasDb } from './db';
import type {
	FactBundle,
	Member,
	PersonMonth,
	PersonPeer,
	PersonResult,
	PersonTotals,
	PrFact,
	Repo,
	Selection,
} from './github/types';

const HOUR = 3_600_000;

/**
 * Below this many observations a median describes one PR more than it describes
 * a person, so the totals report it as null and the UI shows nothing. The
 * per-month series uses no floor: a chart is read as a shape over time, where
 * the point count is itself visible, not as a verdict on someone.
 */
export const MIN_MEDIAN_SAMPLE = 3;

const rk = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;
const prKey = (r: { owner: string; repo: string }, n: number) => `${rk(r)}#${n}`;
const monthOf = (d: Date) => monthKey({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
const eq = (a: string | null | undefined, b: string | null | undefined) =>
	!!a && !!b && a.toLowerCase() === b.toLowerCase();
/** Median of a sample, or null when there is nothing (or too little) to measure. */
const med = (xs: number[], floor: number): number | null =>
	xs.length >= floor ? round(median(xs), 1) : null;

export type PersonOptions = {
	repos: Repo[];
	/** The whole roster: attribution rules are roster-wide (a shared email owned
	 * by two members attributes to neither), so one member is not enough. */
	members: Member[];
	/** The member to report on, as spelled in the roster. */
	login: string;
	/** Month buckets, ascending — the team report's member window. */
	months: Month[];
};

/** Pure: fold facts into one member's report. */
export function buildPersonStats(
	bundle: FactBundle,
	opts: PersonOptions,
	generatedAt: number,
): PersonResult {
	const { repos, members, login, months } = opts;
	const { byLogin, byEmail } = memberMaps(members);
	// Canonicalize through the roster so Octo-Cat and octo-cat are one person.
	// A login outside the roster matches nothing and yields an all-zero report,
	// which is the honest answer for someone who is not on the team.
	const canon = (l: string | null | undefined) => (l ? (byLogin.get(l.toLowerCase()) ?? null) : null);
	const isMe = (l: string | null | undefined) => eq(canon(l), login);

	const want = new Set(repos.map(rk));
	const winStart = monthStartMs(months[0]);
	const winEnd = monthEndMs(months[months.length - 1]);
	const inWin = (d: Date | null | undefined) =>
		!!d && d.getTime() >= winStart && d.getTime() <= winEnd;

	// Zero-filled month rows, plus the per-month samples backing their medians.
	const rows = new Map<string, PersonMonth>();
	const cycleByMonth = new Map<string, number[]>();
	const pickupByMonth = new Map<string, number[]>();
	for (const m of months) {
		const key = monthKey(m);
		rows.set(key, {
			month: key,
			commits: 0,
			prsCreated: 0,
			prsMerged: 0,
			additions: 0,
			deletions: 0,
			reviewsGiven: 0,
			commentsGiven: 0,
			reviewsReceived: 0,
			cycleHours: null,
			pickupHours: null,
		});
		cycleByMonth.set(key, []);
		pickupByMonth.set(key, []);
	}

	// --- commits ---------------------------------------------------------------
	for (const c of bundle.commits) {
		if (!want.has(rk(c)) || !inWin(c.committedAt)) continue;
		if (!eq(pickCommitMember(commitAuthor(c), byLogin, byEmail), login)) continue;
		const r = rows.get(monthOf(c.committedAt));
		if (r) r.commits += 1;
	}

	// --- PRs they authored -----------------------------------------------------
	// Every in-scope PR is indexed, not just theirs: pickup latency needs the open
	// time of PRs written by other people.
	const prByKey = new Map<string, PrFact>();
	let prsCreated = 0;
	let prsMerged = 0;
	let prsClosedUnmerged = 0;
	const sizes: number[] = [];
	const cycles: number[] = [];
	const mergedKeys = new Set<string>();
	for (const p of bundle.prs) {
		if (!want.has(rk(p))) continue;
		prByKey.set(prKey(p, p.number), p);
		if (!isMe(p.author)) continue;
		if (inWin(p.createdAt)) {
			prsCreated += 1;
			const r = rows.get(monthOf(p.createdAt));
			if (r) r.prsCreated += 1;
		}
		if (p.mergedAt && inWin(p.mergedAt)) {
			prsMerged += 1;
			mergedKeys.add(prKey(p, p.number));
			const r = rows.get(monthOf(p.mergedAt));
			if (r) {
				r.prsMerged += 1;
				r.additions += p.additions;
				r.deletions += p.deletions;
			}
			sizes.push(p.additions + p.deletions);
			const h = (p.mergedAt.getTime() - p.createdAt.getTime()) / HOUR;
			if (h >= 0) {
				cycles.push(h);
				cycleByMonth.get(monthOf(p.mergedAt))?.push(h);
			}
		} else if (!p.mergedAt && p.closedAt && inWin(p.closedAt)) {
			prsClosedUnmerged += 1;
		}
	}

	// --- review events, both directions ----------------------------------------
	let reviewsGiven = 0;
	let commentsGiven = 0;
	let approvals = 0;
	let changesRequested = 0;
	let reviewsReceived = 0;
	// Earliest event instant per PR, for the two latency medians.
	const myFirstOnPr = new Map<string, number>();
	const firstOnMyPr = new Map<string, number>();
	const reviewersOnMine = new Set<string>();
	const peers = new Map<string, PersonPeer>();
	const peer = (raw: string) => {
		const key = (canon(raw) ?? raw).toLowerCase();
		let p = peers.get(key);
		if (!p) peers.set(key, (p = { login: canon(raw) ?? raw, given: 0, received: 0 }));
		return p;
	};
	const earliest = (m: Map<string, number>, k: string, t: number) => {
		const prev = m.get(k);
		if (prev === undefined || t < prev) m.set(k, t);
	};

	for (const f of bundle.reviews) {
		if (!want.has(rk(f)) || !inWin(f.ts)) continue;
		// Unsubmitted drafts are not review work, and reviewing your own PR is not
		// review of anyone — the same two exclusions the team aggregation applies.
		if (f.state === 'PENDING') continue;
		if (eq(f.prAuthor, f.reviewer)) continue;
		// Bots review instantly and in bulk; counting them would drown the human
		// numbers and put CodeRabbit at the top of everyone's collaborator list.
		if (f.isBot) continue;
		const k = prKey(f, f.prNumber);
		const t = f.ts.getTime();

		if (isMe(f.reviewer)) {
			const r = rows.get(monthOf(f.ts));
			if (f.kind === 'review') {
				reviewsGiven += 1;
				if (f.state === 'APPROVED') approvals += 1;
				else if (f.state === 'CHANGES_REQUESTED') changesRequested += 1;
				if (r) r.reviewsGiven += 1;
			} else {
				commentsGiven += 1;
				if (r) r.commentsGiven += 1;
			}
			earliest(myFirstOnPr, k, t);
			if (f.prAuthor) peer(f.prAuthor).given += 1;
		}

		if (isMe(f.prAuthor)) {
			if (f.kind === 'review') {
				reviewsReceived += 1;
				const r = rows.get(monthOf(f.ts));
				if (r) r.reviewsReceived += 1;
			}
			reviewersOnMine.add(f.reviewer.toLowerCase());
			earliest(firstOnMyPr, k, t);
			peer(f.reviewer).received += 1;
		}
	}

	// Pickup: how long a PR waited for THIS member's first look at it.
	const pickups: number[] = [];
	for (const [k, t] of myFirstOnPr) {
		const pr = prByKey.get(k);
		if (!pr) continue;
		const h = (t - pr.createdAt.getTime()) / HOUR;
		if (h < 0) continue;
		pickups.push(h);
		pickupByMonth.get(monthOf(new Date(t)))?.push(h);
	}

	// Wait: how long THEIR merged PRs sat before a human looked at them, and how
	// many never got one.
	const waits: number[] = [];
	let unreviewedMerges = 0;
	for (const k of mergedKeys) {
		const first = firstOnMyPr.get(k);
		const pr = prByKey.get(k);
		if (first === undefined) {
			unreviewedMerges += 1;
			continue;
		}
		if (!pr) continue;
		const h = (first - pr.createdAt.getTime()) / HOUR;
		if (h >= 0) waits.push(h);
	}

	for (const [key, xs] of cycleByMonth) rows.get(key)!.cycleHours = med(xs, 1);
	for (const [key, xs] of pickupByMonth) rows.get(key)!.pickupHours = med(xs, 1);

	const closedTotal = prsMerged + prsClosedUnmerged;
	const totals: PersonTotals = {
		prsCreated,
		prsMerged,
		prsClosedUnmerged,
		mergeRatePct: closedTotal ? round((prsMerged / closedTotal) * 100) : 0,
		medianPrSize: med(sizes, MIN_MEDIAN_SAMPLE),
		medianCycleHours: med(cycles, MIN_MEDIAN_SAMPLE),
		reviewsGiven,
		commentsGiven,
		prsReviewed: myFirstOnPr.size,
		approvals,
		changesRequested,
		medianPickupHours: med(pickups, MIN_MEDIAN_SAMPLE),
		reviewsReceived,
		reviewersDistinct: reviewersOnMine.size,
		medianWaitHours: med(waits, MIN_MEDIAN_SAMPLE),
		unreviewedMerges,
	};

	return {
		login,
		totals,
		byMonth: [...rows.values()].sort((a, b) => a.month.localeCompare(b.month)),
		peers: [...peers.values()].sort(
			(a, b) => b.given + b.received - (a.given + a.received) || a.login.localeCompare(b.login),
		),
		generatedAt,
	};
}

/** Build one member's report for a selection (cached upstream by person-cache). */
export async function getPersonReport(
	selection: Selection,
	login: string,
	now: Date = new Date(),
	gql: GraphQL = graphql,
): Promise<PersonResult> {
	const shape = resolveReportShape(selection, now);
	const { bugLabels } = await getAppSettings();
	const todayDay = dayOf(now);
	// Report on the roster's spelling of the login, so the result is stable
	// regardless of how the caller cased it.
	const canonLogin =
		selection.members.find((m) => eq(m.login, login))?.login ?? login;

	let bundle: FactBundle;
	if (!hasDb()) {
		bundle = await fetchFactBundleLive(
			gql,
			selection.repos,
			shape.spanStartDay,
			shape.activityStartDay,
			todayDay,
			bugLabels,
		);
	} else {
		const sync = await ensureFactsSynced(
			selection.repos,
			shape.spanStartDay,
			shape.activityStartDay,
			shape.activityStartDay,
			{ bugLabels, now, swr: true },
			gql,
		);
		bundle = await store.readFactBundle(
			selection.repos,
			new Date(dayStartMs(shape.spanStartDay)),
			new Date(dayStartMs(shape.activityStartDay)),
			now,
		);
		// Partial sync serves what is stored; only a total blank is an error, the
		// same rule the team report uses.
		if (sync.failed.length && !bundle.prs.length && !bundle.commits.length) {
			throw sync.failed[0].error;
		}
	}

	return buildPersonStats(
		bundle,
		{
			repos: selection.repos,
			members: selection.members,
			login: canonLogin,
			months: shape.memberMonths,
		},
		now.getTime(),
	);
}
