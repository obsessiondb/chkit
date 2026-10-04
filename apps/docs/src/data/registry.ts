import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RegistryCatalog } from '../../../../packages/cli/src/registry/model';

// Build/dev scripts run from apps/docs and generate this catalog before Astro starts.
// Read it as build-time data so source analysis does not require generated files.
const registry: RegistryCatalog = JSON.parse(readFileSync(resolve('public/r/registry.json'), 'utf8'));

export type RegistryReferenceSection = 'overview' | 'authentication' | 'scopes' | 'resources' | 'views' | 'sync';

export function registryStrategyLabel(strategy: 'full' | 'timestamp' | 'cursor'): string {
	return { full: 'Full scans', timestamp: 'Timestamp windows', cursor: 'Cursor checkpoints' }[strategy];
}

// The build validates and aggregates provider-local manifests before Astro loads this catalog.
// HTML, raw Markdown, and structured data share the resulting metadata without CLI runtime dependencies.
export const registryApps = registry.items.map((item) => ({
	name: item.name,
	title: item.title,
	description: item.description,
	version: item.meta.chkit.version,
	documentation: item.meta.chkit.documentation ?? `${registry.homepage}/integrations/${item.name}/`,
	href: `/integrations/${item.name}/`,
	logo: item.meta.chkit.logo ? new URL(item.meta.chkit.logo).pathname : undefined,
	root: item.meta.chkit.root,
	resources: item.meta.chkit.resources,
	authentication: item.meta.chkit.authentication,
	views: item.meta.chkit.views,
	sync: item.meta.chkit.sync,
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
		registryReferenceMarkdown(app.name, 'overview'),
		'',
		registryReferenceMarkdown(app.name, 'resources'),
		'',
		`[Integrating ClickHouse with ${app.title}](${app.href}) covers credentials, permissions, storage, and sync limitations.`,
	].join('\n')).join('\n\n');
}

export function registryReferenceMarkdown(name: string, section: RegistryReferenceSection): string {
	const app = registryApps.find((item) => item.name === name);
	if (!app) throw new Error(`Unknown registry app: ${name}`);

	switch (section) {
		case 'overview':
			return table(['Property', 'Included behavior'], [
				['Registry app', `\`${app.name}\` (v${app.version})`],
				['Install command', `\`bunx chkit add ${app.name}\``],
				['Source directory', `\`${app.root}\``],
				['Authentication', app.authentication?.method ?? 'See provider setup'],
				['Environment variables', app.authentication?.env.map((env) => `\`${env}\``).join(', ') ?? 'See provider setup'],
				['ClickHouse', `\`${app.clickhouse}\``],
				['Coverage', `${app.resources.length} synced resources, ${app.views?.length ?? 0} derived views`],
				['Sync strategy', app.strategies.map(registryStrategyLabel).join(', ')],
			]);
		case 'authentication':
			return app.authentication ? [
				...app.authentication.setup.map((step, index) => `${index + 1}. ${step}`),
				'',
				`[${app.title} credential setup](${app.authentication.documentation})`,
			].join('\n') : '';
		case 'scopes':
			return table(['Resource', 'Required scopes'], app.resources.map((resource) => [
				resource.title ?? resource.name,
				resource.scopes.map((scope) => `\`${scope}\``).join(', ') || 'None',
			]));
		case 'resources':
			return table(['Resource', 'Default ClickHouse table', 'Records synced', 'API reference'], app.resources.map((resource) => [
				`${resource.title ?? resource.name} (\`${resource.name}\`)`,
				resource.table ? `\`${resource.table}\`` : 'See source schema',
				resource.description,
				resource.endpoints?.map((endpoint) => `[\`${endpoint.method} ${endpoint.path}\`](${endpoint.documentation})`).join(', ') ?? 'See provider documentation',
			]));
		case 'views':
			return table(['Derived view', 'Source resource', 'Included projection'], (app.views ?? []).map((view) => [
				`\`${view.name}\``, `\`${view.source}\``, view.description,
			]));
		case 'sync':
			return app.sync ? table(['Behavior', 'Details'], [
				['Sync', app.sync.description],
				['Schedule', app.sync.schedule],
				['Deletions', app.sync.deletions],
			]) : '';
	}
}

function table(headers: string[], rows: string[][]): string {
	return [headers, headers.map(() => '---'), ...rows]
		.map((row) => `| ${row.map((cell) => cell.replaceAll('|', '&#124;').replaceAll('\n', ' ')).join(' | ')} |`)
		.join('\n');
}
