import { expect, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setImmediate } from 'node:timers/promises'

import { context, createContextKey, ROOT_CONTEXT, type Context as TraceContext, type ContextManager } from '@opentelemetry/api'

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'

import { foreign, promiseBridge, runPublic, withSpan } from './runtime.js'
import { retryEffect } from './retry.js'

test('the Promise bridge forks with captured services in its owned scope', async () => {
  const marker = Context.Reference<string>('ingest/test/marker', { defaultValue: () => 'missing' })
  const signal = new AbortController().signal
  const result = await runPublic(Effect.scoped(Effect.gen(function* () {
    const bridge = yield* promiseBridge(signal)
    return yield* foreign(() => bridge(marker))
  })).pipe(Effect.provideService(marker, 'captured')))
  expect(result).toBe('captured')
})

test('owned Promise callbacks retain the host tracing context across asynchronous work', async () => {
  const storage = new AsyncLocalStorage<TraceContext>()
  const manager: ContextManager = {
    active: () => storage.getStore() ?? ROOT_CONTEXT,
    with(active, fn, thisArg, ...args) { return storage.run(active, () => fn.apply(thisArg, args)) },
    bind(_active, target) { return target },
    enable() { return this },
    disable() { storage.disable(); return this },
  }
  expect(context.setGlobalContextManager(manager)).toBe(true)
  const key = createContextKey('ingestion-test-request')
  const active = ROOT_CONTEXT.setValue(key, 'request-42')
  const execution = context.with(active, () => runPublic(withSpan('ingestion-test', {}, () => Effect.scoped(Effect.gen(function* () {
    const bridge = yield* promiseBridge(new AbortController().signal)
    return yield* foreign(async () => {
      await setImmediate()
      return bridge(foreign(async () => {
        await setImmediate()
        return context.active().getValue(key)
      }))
    })
  }))))).finally(() => context.disable())
  expect(await execution).toBe('request-42')
})

test.each([undefined, null, 'provider', { provider: 42 }, new Error('provider')])('foreign rejection identity is preserved at Promise boundaries: %s', async (cause) => {
  const failure = await runPublic(foreign(() => Promise.reject(cause))).then(
    () => ({ rejected: false, cause: undefined }),
    (error: unknown) => ({ rejected: true, cause: error })
  )
  expect(failure.rejected).toBe(true)
  expect(failure.cause).toBe(cause)
})

test('pure interruption is a conventional abort error, not an Effect runtime diagnostic', async () => {
  await expect(runPublic(Effect.interrupt)).rejects.toMatchObject({ name: 'AbortError', message: 'Ingestion interrupted' })
})

test('legacy retry abort wrappers preserve the original error without retrying', async () => {
  const originalError = new Error('explicit stop')
  const wrapper = Object.assign(new Error('explicit stop'), { name: 'AbortError', originalError })
  let calls = 0
  await expect(runPublic(retryEffect(() => foreign(async () => {
    calls += 1
    throw wrapper
  }), { minTimeout: 0 }, new AbortController().signal))).rejects.toBe(originalError)
  expect(calls).toBe(1)
})
