import { graphql, type GraphQL } from './github/client';
import { fetchPrFlow } from './github/metrics';
import { lastNMonths, monthsEndingAt, monthKey, monthStart } from './github/months';
import { median, round } from './github/stats';
import { ensureFactsSynced } from './sync';
import * as store from './store';
import { hasDb } from './db';
import { dayOf, dayStartMs } from './days';
import type {
	Repo,
	PrFact,
	ReviewFact,
	PrFlow,
	FlowStats,
	FlowResult,
	BotActivity,
	BotMonthActivity,
} from './github/types';

const HOUR = 3_600_000;
const med = (xs: number[]) => (xs.length ? round(median(xs), 1) : 0);
const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / HOUR;

function statsFor(prs: PrFlow[]): FlowStats {
	const count = prs.length;
	if (!count)
		return {
			count: 0,
			reviewedPct: 0,
			firstReviewHours: 0,
			reviewHours: 0,
			mergeHours: 0,
			postApproveHours: 0,
		};
	const reviewed = prs.filter((p) => p.firstReviewAt);
	const firstReview = reviewed
		.map((p) => hoursBetween(p.createdAt, p.firstReviewAt!))
		.filter((h) => h >= 0);
	// Review time runs first review -> merge (the industry definition), so the whole
	// review-and-rework loop is counted, not just up to an early approval.
	const review = reviewed
		.map((p) => hoursBetween(p.firstReviewAt!, p.mergedAt))
		.filter((h) => h >= 0);
	const merge = prs.map((p) => hoursBetween(p.createdAt, p.mergedAt)).filter((h) => h >= 0);
	const postApprove = prs
		.filter((p) => p.approvedAt)
		.map((p) => hoursBetween(p.approvedAt!, p.mergedAt))
		.filter((h) => h >= 0);
	return {
		count,
		reviewedPct: round((reviewed.length / count) * 100),
		firstReviewHours: med(firstReview),
		reviewHours: med(review),
		mergeHours: med(merge),
		postApproveHours: med(postApprove),
	};
}

/** Aggregate cycle-time + review health from per-PR flow records. Pure. */
export function computeFlow(
	prs: PrFlow[],
	months: string[],
	now: number,
	botActivity: BotActivity[] = [],
	botByMonth: BotMonthActivity[] = [],
): FlowResult {
	const byMonth = months.map((month) => ({
		month,
		...statsFor(prs.filter((p) => p.month === month)),
	}));
	const load = new Map<string, number>();
	for (const p of prs) for (const r of p.reviewers) load.set(r, (load.get(r) ?? 0) + 1);
	const reviewerLoad = [...load.entries()]
		.map(([reviewer, n]) => ({ reviewer, prs: n }))
		.sort((a, b) => b.prs - a.prs);
	return {
		overall: statsFor(prs),
		byMonth,
		reviewerLoad,
		botActivity,
		botByMonth,
		generatedAt: now,
	};
}

/**
 * Pure: reconstruct per-PR flow timelines and bot review activity from stored
 * facts — no GitHub fetch. Mirrors the legacy live extraction: humans drive the
 * latency stats (bots review instantly and would skew them), bots are tallied
 * for the Bots page; the gating approval is the LAST one at/before the merge.
 */
export function buildFlowFromFacts(
	prs: PrFact[],
	reviews: ReviewFact[],
	monthKeys: Set<string>,
): { prs: PrFlow[]; botActivity: BotActivity[]; botByMonth: BotMonthActivity[] } {
	// Only submitted review events participate; PR issue-comments do not.
	const byPr = new Map<string, ReviewFact[]>();
	for (const r of reviews) {
		if (r.kind !== 'review') continue;
		const k = `${r.owner}/${r.repo}#${r.prNumber}`;
		(byPr.get(k) ?? byPr.set(k, []).get(k)!).push(r);
	}

	const out: PrFlow[] = [];
	const botAcc = new Map<string, BotActivity>();
	const botMonth = new Map<string, Map<string, { reviews: number; comments: number }>>();

	for (const pr of prs) {
		if (!pr.mergedAt) continue;
		const month = monthKey({
			year: pr.mergedAt.getUTCFullYear(),
			month: pr.mergedAt.getUTCMonth() + 1,
		});
		if (!monthKeys.has(month)) continue;
		const events = (byPr.get(`${pr.owner}/${pr.repo}#${pr.number}`) ?? [])
			.slice()
			.sort((a, b) => a.ts.getTime() - b.ts.getTime());

		// Bot tallies (verdict reviews + inline comment volume, per PR and month).
		const botsOnPr = new Set<string>();
		let mm = botMonth.get(month);
		if (!mm) botMonth.set(month, (mm = new Map()));
		for (const r of events) {
			if (!r.isBot) continue;
			const b = botAcc.get(r.reviewer) ?? {
				login: r.reviewer,
				avatarUrl: r.avatarUrl ?? '',
				reviews: 0,
				comments: 0,
				prs: 0,
			};
			const verdict = r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED';
			if (verdict) b.reviews += 1;
			b.comments += r.commentsCount;
			if (!b.avatarUrl && r.avatarUrl) b.avatarUrl = r.avatarUrl;
			botAcc.set(r.reviewer, b);
			const bm = mm.get(r.reviewer) ?? { reviews: 0, comments: 0 };
			if (verdict) bm.reviews += 1;
			bm.comments += r.commentsCount;
			mm.set(r.reviewer, bm);
			botsOnPr.add(r.reviewer);
		}
		for (const login of botsOnPr) botAcc.get(login)!.prs += 1;

		// Human timeline only: bots review instantly and would skew latency.
		const human = events.filter((r) => !r.isBot);
		const mergedMs = pr.mergedAt.getTime();
		const approvals = human.filter((r) => r.state === 'APPROVED' && r.ts.getTime() <= mergedMs);
		out.push({
			repo: `${pr.owner}/${pr.repo}`,
			month,
			createdAt: pr.createdAt.toISOString(),
			mergedAt: pr.mergedAt.toISOString(),
			firstReviewAt: human[0]?.ts.toISOString() ?? null,
			approvedAt: approvals.length ? approvals[approvals.length - 1].ts.toISOString() : null,
			reviewers: [...new Set(human.map((r) => r.reviewer))],
		});
	}

	const botActivity = [...botAcc.values()].sort(
		(a, b) => b.reviews + b.comments - (a.reviews + a.comments),
	);
	const botByMonth: BotMonthActivity[] = [];
	for (const [month, mm] of botMonth)
		for (const [login, c] of mm)
			botByMonth.push({ month, login, reviews: c.reviews, comments: c.comments });
	return { prs: out, botActivity, botByMonth };
}

export async function getFlowReport(
	repos: Repo[],
	months: number,
	to?: string,
	now: Date = new Date(),
	gql: GraphQL = graphql,
): Promise<FlowResult> {
	const ms = to ? monthsEndingAt(to, months) : lastNMonths(months, now);
	const keys = ms.map(monthKey);

	// Fact-backed path: sync the window's PR + review facts (tail refreshes run
	// in the background), then aggregate from the store — no per-request GitHub
	// fetch of unchanging history.
	if (hasDb()) {
		const spanStartDay = monthStart(ms[0]);
		await ensureFactsSynced(repos, spanStartDay, dayOf(now), spanStartDay, { now, swr: true }, gql);
		const start = new Date(dayStartMs(spanStartDay));
		const { prs, reviews } = await store.readFlowFacts(repos, start, now);
		const built = buildFlowFromFacts(prs, reviews, new Set(keys));
		return computeFlow(built.prs, keys, now.getTime(), built.botActivity, built.botByMonth);
	}

	// No-DB fallback: the legacy live extraction.
	const { prs, botActivity, botByMonth } = await fetchPrFlow(gql, repos, ms);
	return computeFlow(prs, keys, now.getTime(), botActivity, botByMonth);
}
