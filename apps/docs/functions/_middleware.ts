export const onRequest: PagesFunction<{ ASSETS: Fetcher }> = async (context) => {
	const accept = context.request.headers.get('Accept') ?? '';

	// Only negotiate when the client explicitly asks for markdown.
	// Ignore Accept: */* to avoid breaking browsers.
	if (accept.includes('text/markdown') && !accept.startsWith('*/*')) {
		const url = new URL(context.request.url);

		// Normalise path: strip trailing slash, default to index
		let slug = url.pathname.replace(/\/$/, '') || '/index';
		slug = slug.replace(/^\//, '');

		// Try .md first, fall back to .mdx
		for (const ext of ['.md', '.mdx']) {
			const assetUrl = new URL(`/_raw/${slug}${ext}`, url.origin);
			const asset = await context.env.ASSETS.fetch(assetUrl.toString());

			if (asset.ok) {
				return new Response(asset.body, {
					status: 200,
					headers: {
						'Content-Type': 'text/markdown; charset=utf-8',
						'Vary': 'Accept',
					},
				});
			}
		}
	}

	const response = await context.next();
	const patched = new Response(response.body, response);
	patched.headers.set('Vary', 'Accept');
	return patched;
};
