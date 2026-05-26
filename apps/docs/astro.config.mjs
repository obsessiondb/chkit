// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rawMarkdown from './src/integrations/raw-markdown';

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
					],
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
		rawMarkdown(),
	],
});
