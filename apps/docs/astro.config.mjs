// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import rawMarkdown from './src/integrations/raw-markdown';
import { DOCS_PRODUCTS } from './src/data/docs-products';

const isDev = process.argv.includes('dev');
const enableAgentation = isDev || process.env.PUBLIC_AGENTATION_ENABLED === 'true';

// https://astro.build/config
export default defineConfig({
	// Canonical site URL — required for the @astrojs/sitemap integration,
	// canonical links, and the blog's RSS feed (starlight-blog only emits
	// /blog/rss.xml when `site` is set).
	site: 'https://chkit.obsessiondb.com',
	redirects: {
		'/ingestion': '/sync/',
		'/ingestion/cli': '/sync/cli/',
	},
	integrations: [
		starlight({
			title: 'chkit Docs',
			description: 'Manage ClickHouse schemas in code, review migration SQL, and detect drift with chkit.',
			routeMiddleware: './src/route-data.ts',
			customCss: ['./src/styles/custom.css'],
			// Blog lives at /blog. `navigation: 'none'` so the plugin doesn't
			// override SiteTitle/ThemeSelect (we already override both) — we add
			// our own "Blog" header link instead.
			plugins: [
				starlightBlog({
					title: 'Blog',
					navigation: 'none',
					metrics: { readingTime: true },
					authors: {
						chkit: {
							name: 'The chkit team',
							url: 'https://github.com/obsessiondb/chkit',
						},
						obsessiondb: {
							name: 'Lucas García de Viedma (ObsessionDB)',
							url: 'https://obsessiondb.com',
						},
					},
				}),
			],
			components: {
				Head: './src/components/Head.astro',
				Search: './src/components/Search.astro',
				Sidebar: './src/components/Sidebar.astro',
				Header: './src/components/Header.astro',
				Hero: './src/components/Hero.astro',
				Footer: './src/components/Footer.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				SocialIcons: './src/components/SocialIcons.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			sidebar: [
				{
					label: DOCS_PRODUCTS.schema.label,
					items: [
						{
							label: 'Getting Started',
							items: [
								{ label: 'Overview', slug: 'getting-started' },
								{ label: 'First schema and migration', slug: 'tutorials/first-schema' },
								{ label: 'Add to an existing project', slug: 'getting-started/add-to-existing-project' },
								{ label: 'Start with an example', slug: 'getting-started/with-an-example' },
								{ label: 'For AI Agents', slug: 'ai-agents' },
							],
						},
						{ label: 'Schema', autogenerate: { directory: 'schema' } },
						{ label: 'Configuration', autogenerate: { directory: 'configuration' } },
						{ label: 'Guides', autogenerate: { directory: 'guides' } },
						{
							label: 'Plugins',
							items: [
								{ slug: 'plugins/overview' },
								{ slug: 'plugins/pull' },
								{ slug: 'plugins/codegen' },
								{ slug: 'plugins/backfill' },
							],
						},
						{ label: 'Python (alpha)', autogenerate: { directory: 'python' } },
						{ label: 'ObsessionDB', autogenerate: { directory: 'obsessiondb' } },
						{
							label: 'CLI Reference',
							items: [
								{ slug: 'cli/overview' },
								{ slug: 'cli/init' },
								{ slug: 'cli/generate' },
								{ slug: 'cli/migrate' },
								{ slug: 'cli/status' },
								{ slug: 'cli/drift' },
								{ slug: 'cli/check' },
								{ slug: 'cli/snapshot' },
								{ slug: 'cli/pull' },
								{ slug: 'cli/codegen' },
								{ slug: 'cli/query' },
								{ slug: 'cli/plugin' },
							],
						},
					],
				},
				{
					label: DOCS_PRODUCTS.ingestion.label,
					items: [
						{
							label: 'Getting Started',
							items: [
								{ label: 'Overview', slug: 'sync' },
								{ label: 'Quickstart', slug: 'api-sync/quickstart' },
								{ label: 'How sync works', slug: 'api-sync' },
								{ label: 'Provider templates', slug: 'api-sync/templates' },
								{ label: 'For AI Agents', slug: 'api-sync/agent-skill' },
							],
						},
						{ label: 'Apps & integrations', autogenerate: { directory: 'integrations' } },
						{
							label: 'Build a source',
							items: [
								{ slug: 'api-sync/readers' },
								{ slug: 'api-sync/destinations' },
								{ slug: 'api-sync/incremental-syncs' },
								{ slug: 'api-sync/loading' },
								{ slug: 'api-sync/registry-authoring' },
							],
						},
						{
							label: 'Operations',
							items: [
								{ slug: 'api-sync/operations' },
								{ slug: 'api-sync/testing' },
							],
						},
						{
							label: 'Reference',
							items: [
								{ label: 'CLI overview', slug: 'sync/cli' },
								{ slug: 'cli/ingest' },
								{ slug: 'cli/add' },
								{ slug: 'cli/registry' },
								{ slug: 'plugins/ingest' },
							],
						},
					],
				},
			],
		}),
		sitemap(),
		...(enableAgentation ? [react()] : []),
		rawMarkdown(),
	],
});
