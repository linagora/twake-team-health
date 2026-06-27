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

// Match "bug"/"bugs" as a whole word (also "type:bug", "kind/bug"), but not
// substrings like "debug" or "bugfix" that a plain includes('bug') over-counts.
const BUG_LABEL_RE = /(^|[^a-z])bugs?([^a-z]|$)/i;
/** Whether any label marks the issue as a bug. */
export function isBugLabel(labels: string[]): boolean {
	return labels.some((l) => BUG_LABEL_RE.test(l));
}
