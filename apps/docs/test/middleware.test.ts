import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('markdown content negotiation', () => {
	it('serves the site index as markdown at /', async () => {
		const response = await SELF.fetch('https://docs.test/', {
			headers: { Accept: 'text/markdown' },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
		expect(response.headers.get('Vary')).toBe('Accept');

		const body = await response.text();
		expect(body).toContain('# chkit Documentation');
		expect(body).toContain('## Pages');
		expect(body).toContain('Getting Started');
	});

	it('serves a nested markdown page', async () => {
		const response = await SELF.fetch('https://docs.test/getting-started', {
			headers: { Accept: 'text/markdown' },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');

		const body = await response.text();
		expect(body).toContain('## Prerequisites');
	});

	it('normalises trailing slashes', async () => {
		const response = await SELF.fetch('https://docs.test/getting-started/', {
			headers: { Accept: 'text/markdown' },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
	});

	it('serves deep paths', async () => {
		const response = await SELF.fetch('https://docs.test/cli/overview', {
			headers: { Accept: 'text/markdown' },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');

		const body = await response.text();
		expect(body).toContain('## Commands');
	});

	it('falls through for browser requests', async () => {
		const response = await SELF.fetch('https://docs.test/getting-started', {
			headers: { Accept: 'text/html' },
		});

		expect(response.headers.get('Vary')).toBe('Accept');
		expect(response.headers.get('Content-Type')).not.toBe('text/markdown; charset=utf-8');
	});

	it('does not negotiate on Accept: */*', async () => {
		const response = await SELF.fetch('https://docs.test/getting-started', {
			headers: { Accept: '*/*' },
		});

		expect(response.headers.get('Content-Type')).not.toBe('text/markdown; charset=utf-8');
	});

	it('adds Vary: Accept on passthrough responses', async () => {
		const response = await SELF.fetch('https://docs.test/', {
			headers: { Accept: 'text/html' },
		});

		expect(response.headers.get('Vary')).toBe('Accept');
	});
});
