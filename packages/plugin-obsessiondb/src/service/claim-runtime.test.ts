import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiClient } from '../client.js'
import { claimedEnvelope, provisioningEnvelope } from '../json-envelope.js'
import { claimInstanceFlow } from './claim.js'
import { loadSelectedService } from './storage.js'

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const directories: string[] = []
const running = {
	id: 'fixture-service', slug: 'fixture-service', name: 'Fixture service', status: 'running',
	tier: 4, nodes: 1, connectionUrl: null, connectionUsername: null,
	desiredStatus: 'running', desiredTier: 4, desiredNodes: 1,
	createdAt: '2026-01-01T00:00:00.000Z', managed: true,
}

afterEach(async () => {
	globalThis.fetch = originalFetch
	mock.restore()
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test('claim waits between sequential reads and persists only the running service', async () => {
	const configPath = await temporaryConfig()
	const events: Array<string | number> = []
	const printed: unknown[] = []
	let reads = 0
	spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign(
		<Args extends unknown[]>(callback: (...args: Args) => void, delay?: number, ...args: Args): ReturnType<typeof setTimeout> => {
			events.push(Number(delay))
			return originalSetTimeout(callback, 0, ...args)
		},
		{ __promisify__: originalSetTimeout.__promisify__ },
	))
	const client = scriptedClient(events, async () => {
		reads += 1
		expect(await loadSelectedService(configPath)).toBeNull()
		return { ...running, status: reads === 1 ? 'provisioning' : 'running' }
	})

	expect(await claimInstanceFlow(client, configPath, (value) => printed.push(value), true)).toBe(0)
	expect(events).toEqual(['instanceClaimStatus', 'claimInstance', 'get', 3000, 'get'])
	expect(await loadSelectedService(configPath)).toEqual({ service_slug: running.slug, service_name: running.name })
	expect(printed).toEqual([claimedEnvelope({ service_slug: running.slug, service_name: running.name })])
})

test('claim deadline preserves the provisioning envelope without saving a service', async () => {
	const configPath = await temporaryConfig()
	const events: Array<string | number> = []
	const printed: unknown[] = []
	let currentTime = 1000
	spyOn(Date, 'now').mockImplementation(() => currentTime)
	spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign(
		<Args extends unknown[]>(callback: (...args: Args) => void, delay?: number, ...args: Args): ReturnType<typeof setTimeout> => {
			events.push(Number(delay))
			return originalSetTimeout(callback, 0, ...args)
		},
		{ __promisify__: originalSetTimeout.__promisify__ },
	))
	const client = scriptedClient(events, async () => {
		currentTime += 300_001
		return { ...running, status: 'provisioning' }
	})

	expect(await claimInstanceFlow(client, configPath, (value) => printed.push(value), true)).toBe(1)
	expect(events).toEqual(['instanceClaimStatus', 'claimInstance', 'get', 3000])
	expect(printed).toEqual([provisioningEnvelope()])
	expect(await loadSelectedService(configPath)).toBeNull()
})

test('a failed claim read rejects unchanged and neither retries nor saves the selection', async () => {
	const configPath = await temporaryConfig()
	const events: Array<string | number> = []
	const failure = new Error('read failed')
	const client = scriptedClient(events, async () => { throw failure })

	await expect(claimInstanceFlow(client, configPath, () => {}, true)).rejects.toBe(failure)
	expect(events).toEqual(['instanceClaimStatus', 'claimInstance', 'get'])
	expect(await loadSelectedService(configPath)).toBeNull()
})

async function temporaryConfig(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'chkit-claim-runtime-'))
	directories.push(directory)
	return join(directory, 'clickhouse.config.ts')
}

function scriptedClient(events: Array<string | number>, get: () => Promise<unknown>) {
	globalThis.fetch = Object.assign(mock(async (input: string | URL | Request) => {
		const path = new URL(input instanceof Request ? input.url : String(input)).pathname.split('/').at(-1)
		events.push(String(path))
		if (path === 'instanceClaimStatus') return Response.json({ json: { eligible: true } })
		if (path === 'claimInstance') return Response.json({ json: { outcome: 'claimed', id: running.id, slug: running.slug } })
		if (path === 'get') return Response.json({ json: await get() })
		throw new Error(`Unexpected RPC path: ${path}`)
	}), { preconnect: originalFetch.preconnect })
	return createApiClient({ base_url: 'https://api.example.com', access_token: 'fixture' })
}
