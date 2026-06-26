// Shared helper for mirroring view state into the URL query string. Kept out of
// selection.ts because it imports $app modules (selection.ts is also imported on
// the server via preset.ts).
import { replaceState } from '$app/navigation';
import { page } from '$app/state';

const MAX_RETRIES = 20;

/** Apply mutations to the current URL's query string via replaceState (no history
 * entry). Reads the live location so independent writers (different param sets)
 * merge instead of clobbering within a frame. No-ops when the search is unchanged.
 * During hydration the client router isn't ready yet and replaceState throws, so
 * it retries across frames, bounded so a persistent failure can't loop forever. */
export function replaceSearchParams(
	mutate: (params: URLSearchParams) => void,
	attempt = 0
): void {
	if (typeof window === 'undefined') return;
	const url = new URL(window.location.href);
	mutate(url.searchParams);
	if (url.search === window.location.search) return;
	try {
		replaceState(url, page.state);
	} catch {
		if (attempt < MAX_RETRIES) requestAnimationFrame(() => replaceSearchParams(mutate, attempt + 1));
	}
}
