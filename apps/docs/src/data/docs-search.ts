import { getDocsProduct } from './docs-products';

export const DOCS_SEARCH_LABELS = {
	schema: 'Schema docs',
	sync: 'Sync docs',
	blog: 'Blog',
} as const;

export type DocsSearchScope = keyof typeof DOCS_SEARCH_LABELS;

export function getDocsSearchScope(slug: string): DocsSearchScope {
	const path = slug.replace(/^\/+|\/+$/g, '').replace(/\.md$/, '');
	if (path === 'blog' || path.startsWith('blog/')) return 'blog';
	return getDocsProduct(path) === 'ingestion' ? 'sync' : 'schema';
}
