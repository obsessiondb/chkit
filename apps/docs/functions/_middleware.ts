export const onRequest: PagesFunction<{ ASSETS: Fetcher }> = async (context) => {
	const url = new URL(context.request.url);

	// Serve the raw Markdown asset behind /_raw/ as text/markdown.
	async function serveRaw(slug: string): Promise<Response | null> {
		const assetUrl = new URL(`/_raw/${slug}.md`, url.origin);
		const asset = await context.env.ASSETS.fetch(assetUrl.toString());
		if (!asset.ok) return null;
		return new Response(asset.body, {
			status: 200,
			headers: {
				'Content-Type': 'text/markdown; charset=utf-8',
				'Vary': 'Accept',
			},
		});
	}

	// 1. Explicit ".md" URL (e.g. /ai-agents.md) — serve raw Markdown directly,
	//    no Accept header required. Skip assets already under /_raw/.
	if (url.pathname.endsWith('.md') && !url.pathname.startsWith('/_raw/')) {
		const slug = url.pathname.replace(/^\//, '').replace(/\.md$/, '');
		const raw = await serveRaw(slug);
		if (raw) return raw;
	}

	// 2. Content negotiation — same HTML URL, served as Markdown when the
	//    client explicitly asks for it. Ignore Accept: */* so browsers get HTML.
	const accept = context.request.headers.get('Accept') ?? '';
	if (accept.includes('text/markdown') && !accept.startsWith('*/*')) {
		const slug = (url.pathname.replace(/\/$/, '') || '/index').replace(/^\//, '');
		const raw = await serveRaw(slug);
		if (raw) return raw;
	}

	const response = await context.next();
	const patched = new Response(response.body, response);
	patched.headers.set('Vary', 'Accept');
	return patched;
};
