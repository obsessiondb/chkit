import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { pollDeviceToken } from './api-client.js'

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
	globalThis.fetch = originalFetch
	mock.restore()
})

test('device polling sleeps first and keeps the five-second slow-down increment', async () => {
	const events: Array<string | number> = []
	spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign(
		<Args extends unknown[]>(callback: (...args: Args) => void, delay?: number, ...args: Args): ReturnType<typeof setTimeout> => {
			events.push(Number(delay))
			return originalSetTimeout(callback, 0, ...args)
		},
		{ __promisify__: originalSetTimeout.__promisify__ },
	))
	const responses = [
		{ error: 'slow_down' },
		{ error: 'authorization_pending' },
		{ access_token: 'fixture-token' },
	]
	globalThis.fetch = Object.assign(mock(async () => {
		events.push('request')
		return Response.json(responses.shift())
	}), { preconnect: originalFetch.preconnect })

	expect(await pollDeviceToken('https://api.example.com', 'fixture-code', 0.01, 60)).toBe('fixture-token')
	expect(events).toEqual([10, 'request', 5010, 'request', 5010, 'request'])
})

test('expired device deadlines do not make a request', async () => {
	globalThis.fetch = Object.assign(mock(async () => Response.json({ access_token: 'unexpected' })), { preconnect: originalFetch.preconnect })
	await expect(pollDeviceToken('https://api.example.com', 'fixture-code', 1, 0)).rejects.toThrow('Device code expired')
	expect(globalThis.fetch).not.toHaveBeenCalled()
})

test('an in-flight response may succeed after the deadline without another poll', async () => {
	let currentTime = 1000
	spyOn(Date, 'now').mockImplementation(() => currentTime)
	globalThis.fetch = Object.assign(mock(async () => {
		currentTime = 100_000
		return Response.json({ access_token: 'fixture-token' })
	}), { preconnect: originalFetch.preconnect })
	expect(await pollDeviceToken('https://api.example.com', 'fixture-code', 0.001, 1)).toBe('fixture-token')
	expect(globalThis.fetch).toHaveBeenCalledTimes(1)
})

test('polling stops at the deadline after a pending response', async () => {
	let currentTime = 1000
	spyOn(Date, 'now').mockImplementation(() => currentTime)
	globalThis.fetch = Object.assign(mock(async () => {
		currentTime = 100_000
		return Response.json({ error: 'authorization_pending' })
	}), { preconnect: originalFetch.preconnect })
	await expect(pollDeviceToken('https://api.example.com', 'fixture-code', 0.001, 1)).rejects.toThrow('Device code expired')
	expect(globalThis.fetch).toHaveBeenCalledTimes(1)
})

test('polling preserves a foreign fetch rejection without retrying it', async () => {
	const failure = new Error('connection lost')
	globalThis.fetch = Object.assign(mock(async () => { throw failure }), { preconnect: originalFetch.preconnect })
	await expect(pollDeviceToken('https://api.example.com', 'fixture-code', 0.001, 1)).rejects.toBe(failure)
	expect(globalThis.fetch).toHaveBeenCalledTimes(1)
})
