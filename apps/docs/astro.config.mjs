// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';
import react from '@astrojs/react';
import rawMarkdown from './src/integrations/raw-markdown';

const isDev = process.argv.includes('dev');

// https://astro.build/config
export default defineConfig({
	// Canonical site URL — enables the sitemap, canonical links, and the
	// blog's RSS feed (starlight-blog only emits /blog/rss.xml when `site` is set).
	site: 'https://chkit.obsessiondb.com',
	integrations: [
		starlight({
			title: 'chkit Docs',
			description: 'Public documentation for chkit, the ClickHouse schema and migration CLI.',
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
					label: 'For AI Agents',
					link: '/ai-agents/',
				},
				{
					label: 'Getting Started',
					items: [
						{ label: 'Overview', slug: 'getting-started' },
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
					label: 'ObsessionDB',
					autogenerate: { directory: 'obsessiondb' },
				},
				{
					label: 'Plugins',
					autogenerate: { directory: 'plugins' },
				},
				{
					label: 'CLI Reference',
					autogenerate: { directory: 'cli' },
				},
			],
		}),
		...(isDev ? [react()] : []),
		rawMarkdown(),
	],
});
