import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { registryMarkdown, registryReferenceMarkdown, type RegistryReferenceSection } from '../data/registry';
import { getDocsProduct } from '../data/docs-products';

const BASE_URL = 'https://chkit.obsessiondb.com';
const SITE_TAGLINE = 'ClickHouse schema management in TypeScript, with Python support in beta. Define schemas in code, review migration SQL, and detect drift.';

interface DocEntry {
	slug: string;
	title: string;
	description: string;
	source: string;
}

function stripQuotes(s: string): string {
	return s.replace(/^["']|["']$/g, '');
}

function extractFrontmatter(content: string): { title: string; description: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return { title: '', description: '' };

	const fm = match[1];
	const title = stripQuotes(fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? '');
	const description = stripQuotes(fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '');
	return { title, description };
}

// Strip extension and collapse "index" / "<dir>/index" into the directory slug.
// Windows `relative()` emits backslashes — normalize so slugs are URL-shaped.
function toSlug(rel: string): string {
	return rel
		.replaceAll('\\', '/')
		.replace(/\.mdx?$/, '')
		.replace(/(^|\/)index$/, '');
}

function collectMarkdownFiles(srcDir: string, destDir: string): DocEntry[] {
	const entries: DocEntry[] = [];

	function walk(dir: string) {
		for (const entry of readdirSync(dir)) {
			const fullPath = join(dir, entry);
			if (statSync(fullPath).isDirectory()) {
				walk(fullPath);
			} else if (/\.mdx?$/.test(entry)) {
				const source = expandRegistryReferences(readFileSync(fullPath, 'utf-8'));
				const slug = toSlug(relative(srcDir, fullPath));
				const { title, description } = extractFrontmatter(source);

				// Emit every page as raw Markdown at a clean, slug-based path
				// (e.g. ai-agents.md, cli/migrate.md). The homepage (empty slug)
				// is a marketing page, not useful as Markdown — skip it.
				if (slug !== '') {
					const dest = join(destDir, `${slug}.md`);
					mkdirSync(dirname(dest), { recursive: true });
					writeFileSync(dest, source);
				}

				entries.push({ slug, title, description, source });
			}
		}
	}

	walk(srcDir);
	return entries;
}

// Keep component examples in code fences intact while expanding rendered references.
function expandRegistryReferences(source: string): string {
	return source.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*(?:\n|$))/gm)
		.map((part, index) => index % 2 === 1 ? part : part
			.replace(/^import Registry(?:Apps|Reference) from .+;\n/gm, '')
			.replace('<RegistryApps />', () => registryMarkdown())
			.replace(/<RegistryReference name="([^"]+)" section="(overview|authentication|scopes|resources|views|sync|changelog)" \/>/g, (_match, name: string, section: RegistryReferenceSection) => registryReferenceMarkdown(name, section)))
		.join('');
}

// Sort root pages first, then alphabetically by slug.
function sortEntries(entries: DocEntry[]): DocEntry[] {
	return [...entries].sort((a, b) => {
		const aDepth = a.slug === '' ? -1 : a.slug.split('/').length;
		const bDepth = b.slug === '' ? -1 : b.slug.split('/').length;
		if (aDepth !== bDepth) return aDepth - bDepth;
		return a.slug.localeCompare(b.slug);
	});
}

// Link to the raw Markdown URL of each page (.md), so an agent reading the
// index can fetch each page's Markdown directly without HTML conversion.
function mdUrl(slug: string): string {
	return slug === '' ? `${BASE_URL}/` : `${BASE_URL}/${slug}.md`;
}

// Full sitemap served at /_raw/index.md (and /index.md via routing).
function generateIndex(entries: DocEntry[]): string {
	const lines = ['# chkit Documentation', '', SITE_TAGLINE, ''];
	for (const section of groupEntries(entries)) {
		lines.push(`## ${section.title}`, '', section.description, '');
		for (const entry of section.entries) {
			const desc = entry.description ? ` - ${entry.description}` : '';
			lines.push(`- [${entry.title || entry.slug || '/'}](${mdUrl(entry.slug)})${desc}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

// llms.txt — the agent entry point. https://llmstxt.org/ format: H1, a
// blockquote summary, then product sections linking to their Markdown.
function generateLlmsTxt(entries: DocEntry[]): string {
	const lines = [
		'# chkit',
		'',
		`> ${SITE_TAGLINE}`,
		'',
		'chkit defines ClickHouse schemas, generates and applies reviewable migration SQL, and detects drift. Schema plugins add introspection, type generation, and SQL backfills (beta). Each link below points to the raw Markdown of that page.',
		'',
	];
	for (const section of groupEntries(entries.filter((entry) => entry.slug !== ''))) {
		lines.push(`## ${section.title}`, '', section.description, '');
		for (const entry of section.entries) {
			const desc = entry.description ? `: ${entry.description}` : '';
			lines.push(`- [${entry.title || entry.slug}](${mdUrl(entry.slug)})${desc}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

function groupEntries(entries: DocEntry[]) {
	const sorted = sortEntries(entries);
	const isBlog = (entry: DocEntry) => entry.slug.startsWith('blog/');
	return [
		{
			title: 'Schema Management',
			description: 'Start with getting-started.md or tutorials/first-schema.md. Define schemas, review migrations, and detect drift.',
			entries: sorted.filter((entry) => !isBlog(entry) && getDocsProduct(entry.slug) === 'schema'),
		},
		{
			title: 'Sync (beta)',
			description: 'chkit Sync copies business app data into ClickHouse using editable TypeScript integrations. Start with sync.md; destination schemas and migrations use Schema Management.',
			entries: sorted.filter((entry) => !isBlog(entry) && getDocsProduct(entry.slug) === 'ingestion'),
		},
		{
			title: 'Blog',
			description: 'Articles and project updates.',
			entries: sorted.filter(isBlog),
		},
	];
}

export default function rawMarkdown(): AstroIntegration {
	return {
		name: 'raw-markdown',
		hooks: {
			'astro:build:done': ({ dir, logger }) => {
				const srcDir = fileURLToPath(new URL('../src/content/docs/', dir));
				const distDir = fileURLToPath(dir);
				const rawDir = join(distDir, '_raw');

				const entries = collectMarkdownFiles(srcDir, rawDir);

				mkdirSync(rawDir, { recursive: true });
				writeFileSync(join(rawDir, 'index.md'), generateIndex(entries));
				writeFileSync(join(distDir, 'llms.txt'), generateLlmsTxt(entries));

				const pageCount = entries.filter((e) => e.slug !== '').length;
				logger.info(`Wrote ${pageCount} raw Markdown pages to _raw/`);
				logger.info(`Generated _raw/index.md and llms.txt with ${pageCount} pages`);
			},
		},
	};
}
