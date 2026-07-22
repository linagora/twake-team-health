// Pure numeric helpers, matching the semantics of Python's `statistics` module
// so the ported metrics produce the same numbers as the original generator.

/** Round to `n` decimal places (half away from zero, like the original). */
export function round(x: number, n = 0): number {
	const f = 10 ** n;
	return Math.round((x + Number.EPSILON) * f) / f;
}

/** Median; for an even count, the mean of the two middle values (statistics.median). */
export function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Sample standard deviation (n-1), rounded to 2dp; 0 for fewer than 2 values. */
export function std(xs: number[]): number {
	if (xs.length < 2) return 0;
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
	return round(Math.sqrt(variance), 2);
}

// Match "bug"/"defect" as whole words in a label (also "type:bug", "kind/bug"),
// but not substrings like "debug", "bugfix", or "regression-test" that a plain
// includes() would over-count.
const BUG_LABEL_RE = /(^|[^a-z])(bugs?|defects?)([^a-z]|$)/i;
/** Whether any label marks the issue as a defect (default label heuristic). */
export function isBugLabel(labels: string[]): boolean {
	return labels.some((l) => BUG_LABEL_RE.test(l));
}

/** The signals a defect can be inferred from: an issue's labels and its GitHub
 * native issue type (null when the issue has none, or is not yet refetched). */
export type BugSignal = { labels: string[]; issueType?: string | null };

/** How to classify a defect: admin-configured label names and native issue-type
 * names. Both are additive on top of the built-in defaults, so configuring only
 * ever widens the net. Empty `bugIssueTypes` falls back to the "bug" type. */
export type BugConfig = { bugLabels?: string[]; bugIssueTypes?: string[] };

/** A defect classifier over an issue's labels AND native issue type. An issue is
 * a bug when its labels match the default heuristic OR any configured label
 * (union, not replace), OR its issue type matches a configured type
 * (default: "bug"). All matching is case-insensitive. */
export function makeBugMatcher(config: BugConfig = {}): (s: BugSignal) => boolean {
	const labelSet = new Set((config.bugLabels ?? []).map((l) => l.toLowerCase()));
	const types = config.bugIssueTypes?.length ? config.bugIssueTypes : ['bug'];
	const typeSet = new Set(types.map((t) => t.toLowerCase()));
	return (s) => {
		const labels = s.labels ?? [];
		if (isBugLabel(labels)) return true;
		if (labelSet.size && labels.some((l) => labelSet.has(l.toLowerCase()))) return true;
		return !!s.issueType && typeSet.has(s.issueType.toLowerCase());
	};
}
