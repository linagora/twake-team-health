// Charts lazy-mount on scroll (IntersectionObserver), so window.print() would
// capture blank panels for anything off-screen. exportPdf() flips a shared flag
// that forces every chart to render, waits for them to paint, then prints.
let printing = $state(false);

export const printMode = {
	get on() {
		return printing;
	}
};

export async function exportPdf(): Promise<void> {
	printing = true;
	// Two animation frames + a short settle let Svelte mount the charts and
	// layerchart measure its containers before the print snapshot is taken.
	await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
	await new Promise<void>((r) => setTimeout(r, 250));
	try {
		window.print();
	} finally {
		printing = false;
	}
}
