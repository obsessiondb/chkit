export const DOCS_PRODUCTS = {
	schema: { label: 'Schema Management', href: '/getting-started/' },
	ingestion: { label: 'Sync (beta)', href: '/sync/' },
} as const;

export type DocsProduct = keyof typeof DOCS_PRODUCTS;

// Keep source-authoring URLs while giving Sync its own product navigation.
export function getDocsProduct(slug: string): DocsProduct {
	const path = slug.replace(/^\/+|\/+$/g, '').replace(/\.md$/, '');
	return ['sync', 'ingestion', 'api-sync', 'integrations'].some(
		(prefix) => path === prefix || path.startsWith(`${prefix}/`),
	) || ['cli/ingest', 'cli/add', 'cli/registry', 'plugins/ingest'].includes(path)
		? 'ingestion'
		: 'schema';
}
