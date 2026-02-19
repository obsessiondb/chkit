// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'chkit Docs',
			description: 'Public documentation for chkit, the ClickHouse schema and migration CLI.',
			customCss: ['./src/styles/custom.css'],
			sidebar: [
				{
					label: 'Overview',
					items: [
						{ label: 'Introduction', slug: 'index' },
						{ label: 'Getting Started', slug: 'getting-started' },
						{ label: 'Documentation Structure', slug: 'documentation-structure' },
					],
				},
				{
					label: 'CLI Reference',
					autogenerate: { directory: 'cli' },
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
					label: 'Plugins',
					autogenerate: { directory: 'plugins' },
				},
			],
		}),
	],
});
