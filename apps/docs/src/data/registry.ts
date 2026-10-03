import registry from '../../../../registry/registry.json';

interface AppCatalogItem {
	name: string;
	title: string;
	description: string;
	meta: {
		chkit: {
			version: string;
			documentation?: string;
			logo?: string;
			resources: { name: string; description: string; strategy: string }[];
			clickhouse: string;
			language: string;
		};
	};
}

// Shared by the rendered catalog, structured data, and agent-readable catalog.
// The build's registry check validates the full manifest. Keep the site's data
// projection independent of CLI runtime dependencies and their Zod version.
export const registryApps = registry.items.map((item: AppCatalogItem) => ({
	name: item.name,
	title: item.title,
	description: item.description,
	version: item.meta.chkit.version,
	documentation: item.meta.chkit.documentation ?? `${registry.homepage}/integrations/${item.name}/`,
	href: `/integrations/${item.name}/`,
	logo: item.meta.chkit.logo ? new URL(item.meta.chkit.logo).pathname : undefined,
	resources: item.meta.chkit.resources,
	clickhouse: item.meta.chkit.clickhouse,
	language: item.meta.chkit.language,
	strategies: [...new Set(item.meta.chkit.resources.map((resource) => resource.strategy))],
}));

export function registryMarkdown(): string {
	return registryApps.map((app) => [
		`### [${app.title}](${app.href})`,
		'',
		app.description,
		'',
		`Install: \`bunx chkit add ${app.name}\`. Template version: ${app.version}. ClickHouse: \`${app.clickhouse}\`.`,
		'',
		'| Resource | Records synced | Strategy |',
		'| --- | --- | --- |',
		...app.resources.map((resource) => `| \`${resource.name}\` | ${resource.description} | ${resource.strategy} |`),
		'',
		`[Integrating ClickHouse with ${app.title}](${app.href}) covers setup, permissions, storage, and sync limitations.`,
	].join('\n')).join('\n\n');
}
