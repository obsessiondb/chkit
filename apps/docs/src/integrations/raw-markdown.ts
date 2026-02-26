import { cpSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import type { AstroIntegration } from 'astro';

interface DocEntry {
	slug: string;
	title: string;
	description: string;
}

function stripQuotes(s: string): string {
	return s.replace(/^["']|["']$/g, '');
}

function extractFrontmatter(filePath: string): { title: string; description: string } {
	const content = readFileSync(filePath, 'utf-8');
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return { title: '', description: '' };

	const fm = match[1];
	const title = stripQuotes(fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? '');
	const description = stripQuotes(fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '');
	return { title, description };
}

function collectMarkdownFiles(srcDir: string, destDir: string): DocEntry[] {
	const entries: DocEntry[] = [];

	function walk(dir: string) {
		for (const entry of readdirSync(dir)) {
			const fullPath = join(dir, entry);
			if (statSync(fullPath).isDirectory()) {
				walk(fullPath);
			} else if (/\.mdx?$/.test(entry)) {
				const rel = relative(srcDir, fullPath);
				const dest = join(destDir, rel);
				mkdirSync(dirname(dest), { recursive: true });
				cpSync(fullPath, dest);

				// Build slug: strip extension, "index" becomes ""
				let slug = rel.replace(/\.mdx?$/, '');
				if (slug === 'index') slug = '';

				const { title, description } = extractFrontmatter(fullPath);
				entries.push({ slug, title, description });
			}
		}
	}

	walk(srcDir);
	return entries;
}

function generateIndex(entries: DocEntry[], baseUrl: string): string {
	const lines: string[] = [
		'# chkit Documentation',
		'',
		'ClickHouse schema management and migration toolkit for TypeScript.',
		'',
		'## Pages',
		'',
	];

	// Sort: root pages first, then by slug alphabetically
	const sorted = [...entries].sort((a, b) => {
		const aDepth = a.slug === '' ? -1 : a.slug.split('/').length;
		const bDepth = b.slug === '' ? -1 : b.slug.split('/').length;
		if (aDepth !== bDepth) return aDepth - bDepth;
		return a.slug.localeCompare(b.slug);
	});

	for (const entry of sorted) {
		const path = entry.slug === '' ? '/' : `/${entry.slug}/`;
		const url = `${baseUrl}${path}`;
		const desc = entry.description ? ` - ${entry.description}` : '';
		lines.push(`- [${entry.title || path}](${url})${desc}`);
	}

	lines.push('');
	return lines.join('\n');
}

export default function rawMarkdown(): AstroIntegration {
	return {
		name: 'raw-markdown',
		hooks: {
			'astro:build:done': ({ dir, logger }) => {
				const srcDir = new URL('../src/content/docs/', dir).pathname;
				const destDir = new URL('_raw/', dir).pathname;

				const entries = collectMarkdownFiles(srcDir, destDir);

				// Generate index.md as a full sitemap for agents
				const baseUrl = 'https://chkit.obsessiondb.com';
				const index = generateIndex(entries, baseUrl);
				mkdirSync(destDir, { recursive: true });
				writeFileSync(join(destDir, 'index.md'), index);

				logger.info(`Copied ${entries.length} markdown files to _raw/`);
				logger.info(`Generated index.md with ${entries.length} pages`);
			},
		},
	};
}
