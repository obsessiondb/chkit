import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
	STANDARD_RPC_JSON_SERIALIZER_BUILT_IN_TYPES,
	StandardRPCJsonSerializer,
	StandardRPCSerializer,
} from '@orpc/client/standard'
import { SessionExpiredError } from './api-request.js'
import { createApiClient } from './client.js'

const pollutionKey = '__chkit_orpc_pollution_test__'
const prototype = Object.prototype as Record<string, unknown>

describe('oRPC deserialization security', () => {
	afterEach(() => {
		delete prototype[pollutionKey]
	})

	// GHSA-m272-9rp6-32mc: neither metadata nor multipart maps may traverse
	// inherited properties and write to Object.prototype.
	for (const path of [
		['__proto__', pollutionKey],
		['constructor', 'prototype', pollutionKey],
	]) {
		test(`rejects metadata traversing ${path.join('.')}`, () => {
			const serializer = new StandardRPCJsonSerializer()
			expect(() =>
				serializer.deserialize({}, [
					[STANDARD_RPC_JSON_SERIALIZER_BUILT_IN_TYPES.UNDEFINED, ...path],
				]),
			).toThrow()
			expect(Object.hasOwn(prototype, pollutionKey)).toBe(false)
		})

		test(`rejects multipart maps traversing ${path.join('.')}`, () => {
			const serializer = new StandardRPCJsonSerializer()
			expect(() =>
				serializer.deserialize({}, [], [path], () => new Blob(['polluted'])),
			).toThrow()
			expect(Object.hasOwn(prototype, pollutionKey)).toBe(false)
		})
	}

	// GHSA-4p2c-m292-ghmh: duplicate metadata must not repeatedly reconstruct
	// collections from already-deserialized values. Keep the fixture tiny.
	test('rejects repeated Set metadata', () => {
		const serializer = new StandardRPCJsonSerializer()
		const type = STANDARD_RPC_JSON_SERIALIZER_BUILT_IN_TYPES.SET
		expect(() => serializer.deserialize([1, 2], [[type], [type]])).toThrow()
	})

	test('round-trips rich values repeatedly without mutating the wire data', () => {
		const serializer = new StandardRPCJsonSerializer()
		const value = {
			date: new Date('2026-01-01T00:00:00Z'),
			bigint: 42n,
			set: new Set(['a', 'b']),
			map: new Map([['key', 'value']]),
		}
		const [json, meta] = serializer.serialize(value)
		const wireData = JSON.stringify({ json, meta })
		expect(serializer.deserialize(json, meta)).toEqual(value)
		expect(serializer.deserialize(json, meta)).toEqual(value)
		expect(JSON.stringify({ json, meta })).toBe(wireData)
	})

	test('rejects a string multipart field that would resize an array', () => {
		const serializer = new StandardRPCSerializer(
			new StandardRPCJsonSerializer(),
		)
		const form = new FormData()
		form.set(
			'data',
			JSON.stringify({
				json: [1],
				meta: [[STANDARD_RPC_JSON_SERIALIZER_BUILT_IN_TYPES.SET]],
				maps: [['length']],
			}),
		)
		// A tiny value exercises the validation without allocating a large array.
		form.set('0', '16')
		expect(() => serializer.deserialize(form)).toThrow()
	})

	test('rejects missing multipart blobs', () => {
		const serializer = new StandardRPCSerializer(
			new StandardRPCJsonSerializer(),
		)
		const form = new FormData()
		form.set('data', JSON.stringify({ json: [null], maps: [[0]] }))
		expect(() => serializer.deserialize(form)).toThrow()
	})

	test('round-trips valid multipart blobs', async () => {
		const serializer = new StandardRPCSerializer(
			new StandardRPCJsonSerializer(),
		)
		const encoded = serializer.serialize({ file: new Blob(['hello']) })
		expect(encoded).toBeInstanceOf(FormData)
		const decoded = serializer.deserialize(encoded) as { file: Blob }
		expect(await decoded.file.text()).toBe('hello')
	})
})

describe('createApiClient transport', () => {
	const client = createApiClient({
		base_url: 'https://api.example.test',
		access_token: 'test-token',
	})
	let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined

	afterEach(() => {
		fetchSpy?.mockRestore()
		delete prototype[pollutionKey]
	})

	test('preserves the RPC path, input, auth headers, and response', async () => {
		fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
			async (input, init) => {
				const request = new Request(input, init)
				expect(request.url).toBe('https://api.example.test/rpc/services/list')
				expect(request.method).toBe('POST')
				expect(request.headers.get('Authorization')).toBe('Bearer test-token')
				expect(request.headers.get('User-Agent')).toMatch(/^chkit\//)
				expect(await request.json()).toEqual({ json: {} })
				return Response.json({ json: { services: [] } })
			},
		)

		await expect(client.services.list({})).resolves.toEqual({ services: [] })
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	test('preserves session-expired errors', async () => {
		fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(null, { status: 401 }),
		)
		await expect(client.services.list({})).rejects.toBeInstanceOf(
			SessionExpiredError,
		)
	})

	// #305: the console resolves a slug in the session's active organization only
	// and answers a service of another organization with a bare 404.
	test('explains a NOT_FOUND for a service of another organization', async () => {
		const requested: string[] = []
		fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
			async (input, init) => {
				const request = new Request(input, init)
				const { pathname } = new URL(request.url)
				requested.push(pathname)
				if (pathname === '/rpc/workbench/query/execute') {
					return Response.json({ error: 'Service not found' }, { status: 404 })
				}
				if (pathname === '/rpc/services/listAll') {
					return Response.json({
						json: {
							organizations: [
								{ id: 'org-acme', name: 'Acme', slug: 'acme', services: [] },
								{
									id: 'org-bench',
									name: 'Benchmarks',
									slug: 'benchmarks',
									services: [{ slug: 'benchmarks', name: 'benchmarks' }],
								},
							],
						},
					})
				}
				expect(pathname).toBe('/api/auth/get-session')
				expect(request.headers.get('Authorization')).toBe('Bearer test-token')
				return Response.json({
					user: { id: 'u1', name: 'User', email: 'user@example.test' },
					session: { activeOrganizationId: 'org-acme' },
				})
			},
		)

		await expect(
			client.workbench.query.execute({ serviceSlug: 'benchmarks', query: 'SELECT 1' }),
		).rejects.toMatchObject({
			code: 'service_not_in_active_organization',
			message: expect.stringContaining(
				'service "benchmarks" is not in the active organization "Acme" of this chkit session (it belongs to "Benchmarks")',
			),
		})
		expect(requested.sort()).toEqual([
			'/api/auth/get-session',
			'/rpc/services/listAll',
			'/rpc/workbench/query/execute',
		])
	})

	test('leaves a NOT_FOUND of a call without a service unchanged', async () => {
		fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json({ error: 'Not found' }, { status: 404 }),
		)
		await expect(client.services.list({})).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	test('rejects a prototype-polluting RPC response', async () => {
		fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json({
				json: {},
				meta: [
					[
						STANDARD_RPC_JSON_SERIALIZER_BUILT_IN_TYPES.UNDEFINED,
						'__proto__',
						pollutionKey,
					],
				],
			}),
		)
		await expect(client.services.list({})).rejects.toThrow()
		expect(Object.hasOwn(prototype, pollutionKey)).toBe(false)
	})
})
