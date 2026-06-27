import { graphql, type GraphQL } from './github/client';
import { fetchPrFlow } from './github/metrics';
import { lastNMonths, monthsEndingAt, monthKey } from './github/months';
import { median, round } from './github/stats';
import type { Repo, PrFlow, FlowStats, FlowResult } from './github/types';

const HOUR = 3_600_000;
const med = (xs: number[]) => (xs.length ? round(median(xs), 1) : 0);
const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / HOUR;

function statsFor(prs: PrFlow[]): FlowStats {
	const count = prs.length;
	if (!count)
		return { count: 0, reviewedPct: 0, firstReviewHours: 0, reviewHours: 0, mergeHours: 0, postApproveHours: 0 };
	const reviewed = prs.filter((p) => p.firstReviewAt);
	const firstReview = reviewed.map((p) => hoursBetween(p.createdAt, p.firstReviewAt!)).filter((h) => h >= 0);
	const review = prs
		.filter((p) => p.firstReviewAt && p.approvedAt)
		.map((p) => hoursBetween(p.firstReviewAt!, p.approvedAt!))
		.filter((h) => h >= 0);
	const merge = prs.map((p) => hoursBetween(p.createdAt, p.mergedAt)).filter((h) => h >= 0);
	const postApprove = prs.filter((p) => p.approvedAt).map((p) => hoursBetween(p.approvedAt!, p.mergedAt)).filter((h) => h >= 0);
	return {
		count,
		reviewedPct: round((reviewed.length / count) * 100),
		firstReviewHours: med(firstReview),
		reviewHours: med(review),
		mergeHours: med(merge),
		postApproveHours: med(postApprove)
	};
}

/** Aggregate cycle-time + review health from per-PR flow records. Pure. */
export function computeFlow(prs: PrFlow[], months: string[], now: number): FlowResult {
	const byMonth = months.map((month) => ({ month, ...statsFor(prs.filter((p) => p.month === month)) }));
	const load = new Map<string, number>();
	for (const p of prs) for (const r of p.reviewers) load.set(r, (load.get(r) ?? 0) + 1);
	const reviewerLoad = [...load.entries()].map(([reviewer, n]) => ({ reviewer, prs: n })).sort((a, b) => b.prs - a.prs);
	return { overall: statsFor(prs), byMonth, reviewerLoad, generatedAt: now };
}

export async function getFlowReport(
	repos: Repo[],
	months: number,
	to?: string,
	now: Date = new Date(),
	gql: GraphQL = graphql
): Promise<FlowResult> {
	const ms = to ? monthsEndingAt(to, months) : lastNMonths(months, now);
	const prs = await fetchPrFlow(gql, repos, ms);
	return computeFlow(prs, ms.map(monthKey), now.getTime());
}
