import { describe, expect, test } from 'bun:test'

import { buildJobConsoleUrl, consoleWebBaseUrl } from './console-url'

describe('consoleWebBaseUrl', () => {
	test('maps the console-api host to the web console host', () => {
		expect(consoleWebBaseUrl('https://console-api.obsessiondb.com')).toBe(
			'https://console.obsessiondb.com',
		)
	})

	test('drops any path on the API base url', () => {
		expect(consoleWebBaseUrl('https://console-api.obsessiondb.com/rpc')).toBe(
			'https://console.obsessiondb.com',
		)
	})

	test('strips an -api segment for non-console hosts', () => {
		expect(consoleWebBaseUrl('https://my-api.example.com')).toBe('https://my.example.com')
	})

	test('returns the origin unchanged when no -api mapping applies', () => {
		expect(consoleWebBaseUrl('http://localhost:3000')).toBe('http://localhost:3000')
	})

	test('falls back to the trimmed string for an unparseable url', () => {
		expect(consoleWebBaseUrl('not-a-url')).toBe('not-a-url')
	})
})

describe('buildJobConsoleUrl', () => {
	test('builds a service/jobs/job deep link', () => {
		expect(
			buildJobConsoleUrl('https://console-api.obsessiondb.com', 'my-service', 'job-123'),
		).toBe('https://console.obsessiondb.com/my-service/jobs/job-123')
	})

	test('url-encodes the slug and job id', () => {
		expect(buildJobConsoleUrl('https://console-api.obsessiondb.com', 'a b', 'j/1')).toBe(
			'https://console.obsessiondb.com/a%20b/jobs/j%2F1',
		)
	})
})
