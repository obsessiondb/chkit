// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'CHX Docs',
			description: 'Public documentation for chx, the ClickHouse schema and migration CLI.',
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
			],
		}),
	],
});
