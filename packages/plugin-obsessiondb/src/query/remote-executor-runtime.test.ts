import { afterEach, expect, mock, test } from 'bun:test'
import { SessionExpiredError } from '../api-request.js'
import { createRemoteExecutor } from './remote-executor.js'

const originalFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = originalFetch
})

test('table introspection starts all three reads concurrently', async () => {
	const allStarted = Promise.withResolvers<void>()
	let requests = 0
	globalThis.fetch = Object.assign(mock(async () => {
		requests += 1
		if (requests === 3) allStarted.resolve()
		await allStarted.promise
		return Response.json({ json: { data: [], meta: [], rows: 0 } })
	}), { preconnect: originalFetch.preconnect })

	expect(await remote().listTableDetails(['default'])).toEqual([])
	expect(requests).toBe(3)
})

test('introspection failure interrupts sibling HTTP reads and preserves the failure', async () => {
	const allStarted = Promise.withResolvers<void>()
	const failure = new Error('introspection unavailable')
	let requests = 0
	let aborted = 0
	globalThis.fetch = Object.assign(mock(async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(String(input), init)
		requests += 1
		const index = requests
		if (requests === 3) allStarted.resolve()
		if (index === 1) {
			await allStarted.promise
			throw failure
		}
		return new Promise<Response>((_resolve, reject) => {
			request.signal.addEventListener('abort', () => {
				aborted += 1
				reject(request.signal.reason)
			}, { once: true })
		})
	}), { preconnect: originalFetch.preconnect })

	await expect(remote().listTableDetails(['default'])).rejects.toBe(failure)
	expect(requests).toBe(3)
	expect(aborted).toBe(2)
})

test('remote executor preserves session errors rather than runtime wrappers', async () => {
	globalThis.fetch = Object.assign(mock(async () => new Response('Unauthorized', { status: 401 })), { preconnect: originalFetch.preconnect })
	await expect(remote().command('SELECT 1')).rejects.toBeInstanceOf(SessionExpiredError)
})

test('empty introspection and inserts do not open HTTP requests', async () => {
	globalThis.fetch = Object.assign(mock(async () => { throw new Error('unexpected request') }), { preconnect: originalFetch.preconnect })
	const executor = remote()
	expect(await executor.listTableDetails([])).toEqual([])
	await executor.insert({ table: 'default.events', values: [] })
	await executor.close()
	expect(globalThis.fetch).not.toHaveBeenCalled()
})

function remote() {
	return createRemoteExecutor({
		credentials: { base_url: 'https://api.example.com', access_token: 'fixture' },
		serviceSlug: 'fixture-service',
	})
}
