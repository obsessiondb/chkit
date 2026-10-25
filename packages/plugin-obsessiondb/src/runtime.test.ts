import { expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import { fromPromise, runEffect } from './runtime.js'

test('foreign Promise failures keep the original value, including undefined', async () => {
	for (const failure of [new Error('foreign'), { code: 'foreign' }, 'foreign', undefined]) {
		await expect(runEffect(fromPromise(() => Promise.reject(failure)))).rejects.toBe(failure)
	}
})

test('synchronous callbacks keep their original thrown value', async () => {
	const failure = { code: 'synchronous' }
	await expect(runEffect(fromPromise(() => { throw failure }))).rejects.toBe(failure)
	await expect(runEffect(Effect.sync(() => { throw failure }))).rejects.toBe(failure)
})

test('cleanup runs once and preserves finally error precedence', async () => {
	const failure = new Error('operation failed')
	const cleanupFailure = new Error('cleanup failed')
	let releases = 0
	const operation = Effect.acquireUseRelease(
		Effect.succeed('owned'),
		() => fromPromise(() => Promise.reject(failure)),
		() => fromPromise(async () => {
			releases += 1
			throw cleanupFailure
		}),
	)
	await expect(runEffect(operation)).rejects.toBe(cleanupFailure)
	expect(releases).toBe(1)
})

test('a cleanup failure after success keeps its original value', async () => {
	const failure = new Error('close failed')
	await expect(runEffect(Effect.acquireUseRelease(
		Effect.succeed('owned'),
		() => Effect.succeed('done'),
		() => fromPromise(() => Promise.reject(failure)),
	))).rejects.toBe(failure)
})

test('interruption produces a plain AbortError rather than an Effect cause', async () => {
	await expect(runEffect(Effect.interrupt)).rejects.toMatchObject({
		name: 'AbortError',
		message: 'ObsessionDB operation interrupted.',
	})
})
