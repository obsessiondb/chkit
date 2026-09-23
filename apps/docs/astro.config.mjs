// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import rawMarkdown from './src/integrations/raw-markdown';

const isDev = process.argv.includes('dev');

// https://astro.build/config
export default defineConfig({
	// Canonical site URL — required for the @astrojs/sitemap integration,
	// canonical links, and the blog's RSS feed (starlight-blog only emits
	// /blog/rss.xml when `site` is set).
	site: 'https://chkit.obsessiondb.com',
	integrations: [
		starlight({
			title: 'chkit Docs',
			description: 'Define ClickHouse schemas, review migrations, and sync API data into your tables with chkit.',
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
				Header: './src/components/Header.astro',
				Hero: './src/components/Hero.astro',
				Footer: './src/components/Footer.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				SocialIcons: './src/components/SocialIcons.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Overview', slug: 'getting-started' },
						{ label: 'For AI Agents', slug: 'ai-agents' },
						{ label: 'Start with an example', slug: 'getting-started/with-an-example' },
						{ label: 'Add to an existing project', slug: 'getting-started/add-to-existing-project' },
					],
				},
				{
					label: 'Tutorials',
					autogenerate: { directory: 'tutorials' },
				},
				{
					label: 'Configuration',
					autogenerate: { directory: 'configuration' },
				},
				{
					label: 'Guides',
					autogenerate: { directory: 'guides' },
				},
				{
					label: 'Schema',
					autogenerate: { directory: 'schema' },
				},
				{
					label: 'Ingestion',
					items: [
						{ label: 'Overview', slug: 'ingestion' },
						{ label: 'Quickstart', slug: 'ingestion/quickstart' },
						{ label: 'Authoring skill', slug: 'ingestion/agent-skill' },
						{
							label: 'Build a source',
							collapsed: true,
							items: [
								{ slug: 'ingestion/readers' },
								{ slug: 'ingestion/destinations' },
								{ slug: 'ingestion/incremental-syncs' },
								{ slug: 'ingestion/loading' },
							],
						},
						{
							label: 'Run and verify',
							collapsed: true,
							items: [
								{ slug: 'ingestion/operations' },
								{ slug: 'ingestion/testing' },
							],
						},
					],
				},
				{
					label: 'ObsessionDB',
					autogenerate: { directory: 'obsessiondb' },
				},
				{
					label: 'Plugins',
					autogenerate: { directory: 'plugins' },
				},
				{
					label: 'Python',
					autogenerate: { directory: 'python' },
				},
				{
					label: 'CLI Reference',
					autogenerate: { directory: 'cli' },
				},
			],
		}),
		sitemap(),
		...(isDev ? [react()] : []),
		rawMarkdown(),
	],
});
