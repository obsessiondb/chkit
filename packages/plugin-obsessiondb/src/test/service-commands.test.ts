import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saveCredentials } from '../auth/credentials.js'
import { SERVICE_COMMAND } from '../service/commands.js'
import { loadServiceAliases } from '../service/storage.js'

describe('service alias command', () => {
	let tempDir: string
	let originalXdg: string | undefined
	const originalFetch = globalThis.fetch

	afterEach(async () => {
		globalThis.fetch = originalFetch
		if (originalXdg !== undefined) {
			process.env.XDG_CONFIG_HOME = originalXdg
		} else {
			delete process.env.XDG_CONFIG_HOME
		}
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	async function setupAuth() {
		tempDir = await mkdtemp(join(tmpdir(), 'chkit-obd-'))
		originalXdg = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = tempDir
		await saveCredentials({
			access_token: 'test-tok',
			base_url: 'https://api.test.com',
		})
	}

	test('sets an alias for an existing service', async () => {
		await setupAuth()
		const printed: unknown[] = []
		const configPath = join(tempDir, 'project', 'clickhouse.config.ts')

		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						json: {
							organizations: [
								{
									id: 'org-1',
									name: 'Org',
									slug: 'org',
									services: [
										{
											id: 'svc-prod',
											name: 'production',
											status: 'running',
											tier: 1,
											nodes: 1,
											connectionUrl: null,
											connectionUsername: null,
											desiredStatus: 'running',
											desiredTier: 1,
											desiredNodes: 1,
											createdAt: '2026-03-29T00:00:00Z',
											managed: true,
										},
									],
								},
							],
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		) as typeof fetch

		const exitCode = await SERVICE_COMMAND.run({
			configPath,
			args: ['service', 'alias', 'set', 'prod', 'production'],
			flags: {},
			print: (value) => printed.push(value),
		})

		expect(exitCode).toBe(0)
		expect(printed).toContain('Service alias saved: prod -> production')
		expect(await loadServiceAliases(configPath)).toEqual({
			prod: {
				service_id: 'svc-prod',
				service_name: 'production',
			},
		})
	})
})
