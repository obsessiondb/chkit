import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saveCredentials } from '../auth/credentials.js'
import { SERVICE_COMMAND } from './commands.js'
import { loadSelectedService, saveSelectedService } from './storage.js'

const originalFetch = globalThis.fetch
let tempDir: string | undefined
let originalXdg: string | undefined

function service(overrides: {
	id: string
	name: string
	status?: 'running' | 'stopped'
}) {
	return {
		id: overrides.id,
		name: overrides.name,
		status: overrides.status ?? 'running',
		tier: 1,
		nodes: 1,
		connectionUrl: null,
		connectionUsername: null,
		desiredStatus: 'running',
		desiredTier: 1,
		desiredNodes: 1,
		createdAt: '2026-03-29T00:00:00Z',
		managed: true,
	}
}

async function setupAuth(): Promise<string> {
	tempDir = await mkdtemp(join(tmpdir(), 'chkit-obd-service-'))
	originalXdg = process.env.XDG_CONFIG_HOME
	process.env.XDG_CONFIG_HOME = tempDir
	await saveCredentials({
		access_token: 'test-tok',
		base_url: 'https://api.test.com',
	})
	return join(tempDir, 'project', 'clickhouse.config.ts')
}

function mockOrganizations(organizations: unknown[]): void {
	globalThis.fetch = mock(
		async () =>
			new Response(JSON.stringify({ json: { organizations } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
	) as typeof fetch
}

describe('service command', () => {
	afterEach(async () => {
		globalThis.fetch = originalFetch
		if (originalXdg !== undefined) {
			process.env.XDG_CONFIG_HOME = originalXdg
		} else {
			delete process.env.XDG_CONFIG_HOME
		}
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true })
			tempDir = undefined
		}
	})

	test('lists services grouped by organization and marks the default', async () => {
		const configPath = await setupAuth()
		await saveSelectedService(configPath, {
			service_id: 'svc-prod',
			service_name: 'prod',
		})
		mockOrganizations([
			{
				id: 'org-a',
				name: 'Acme',
				slug: 'acme',
				services: [
					service({ id: 'svc-prod', name: 'prod' }),
					service({ id: 'svc-staging', name: 'staging', status: 'stopped' }),
				],
			},
			{
				id: 'org-b',
				name: 'Beta',
				slug: 'beta',
				services: [service({ id: 'svc-beta', name: 'analytics' })],
			},
		])

		const printed: unknown[] = []
		const code = await SERVICE_COMMAND.run({
			configPath,
			args: ['service', 'list'],
			flags: {},
			print: (value) => printed.push(value),
		})

		expect(code).toBe(0)
		expect(printed).toEqual([
			'Services:',
			'Acme (acme):',
			'  - prod (running) [default]',
			'  - staging (stopped)',
			'Beta (beta):',
			'  - analytics (running)',
		])
	})

	test('select auto-selects a single service and stores it as the default', async () => {
		const configPath = await setupAuth()
		mockOrganizations([
			{
				id: 'org-a',
				name: 'Acme',
				slug: 'acme',
				services: [service({ id: 'svc-prod', name: 'prod' })],
			},
		])

		const printed: unknown[] = []
		const code = await SERVICE_COMMAND.run({
			configPath,
			args: ['service', 'select'],
			flags: {},
			print: (value) => printed.push(value),
		})

		expect(code).toBe(0)
		expect(printed).toEqual([
			'Auto-selected service: Acme (acme) / prod (running)',
			'Service selected: Acme (acme) / prod',
		])
		expect(await loadSelectedService(configPath)).toEqual({
			service_id: 'svc-prod',
			service_name: 'prod',
		})
	})
})
