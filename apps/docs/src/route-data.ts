import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { DOCS_PRODUCTS, getDocsProduct } from './data/docs-products';

export const onRequest = defineRouteMiddleware(async (context, next) => {
	await next();
	const route = context.locals.starlightRoute;
	if (route.id === 'blog' || route.id.startsWith('blog/')) return;

	const product = getDocsProduct(route.id);
	const group = route.sidebar.find(
		(item) => item.type === 'group' && item.label === DOCS_PRODUCTS[product].label,
	);
	if (group?.type !== 'group') return;

	route.sidebar = group.entries;
	const previousSiteTitle = route.siteTitle;
	route.siteTitle = `chkit ${DOCS_PRODUCTS[product].label}`;
	// Head metadata is prepared before route middleware runs.
	route.head = route.head.map((item) => {
		if (item.tag === 'title' && item.content?.endsWith(previousSiteTitle)) {
			return { ...item, content: item.content.slice(0, -previousSiteTitle.length) + route.siteTitle };
		}
		if (item.tag === 'meta' && item.attrs?.property === 'og:site_name') {
			return { ...item, attrs: { ...item.attrs, content: route.siteTitle } };
		}
		return item;
	});
	// Starlight calculates pagination before this middleware selects the menu.
	// Keep the last/first page of each product from leading into the other one.
	for (const direction of ['prev', 'next'] as const) {
		const link = route.pagination[direction];
		if (link && getDocsProduct(link.href) !== product) {
			route.pagination[direction] = undefined;
		}
	}
});
