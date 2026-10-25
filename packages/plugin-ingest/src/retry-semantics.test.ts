import { expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'

import { FetchFailure, HttpError } from './errors.js'
import { attemptEffect, runAttempt } from './retry.js'
import { foreign, runPublic } from './runtime.js'

const signal = new AbortController().signal
const immediate = { minTimeout: 0, randomize: false }
const env = { signal, classifier: undefined, onRetry: () => undefined }

test('fractional retry exhaustion retains the established budget behavior', async () => {
  let calls = 0
  await expect(runAttempt(async () => { calls += 1; throw new Error('source') }, {
    ...immediate, retries: 0.5,
  }, env)).rejects.toThrow('Retry attempts exhausted without throwing an error.')
  expect(calls).toBe(1)
})

test('retry consumption runs on the final failure but retry callbacks do not', async () => {
  const calls: string[] = []
  const source = new Error('provider')
  await expect(runAttempt(async () => { throw source }, {
    ...immediate, retries: 1,
    shouldConsumeRetry: async (context) => {
      calls.push(`consume:${context.attemptNumber}:${context.retriesConsumed}:${context.retriesLeft}`)
      expect(context.error.cause).toBe(source)
      return true
    },
    shouldRetry: async (context) => { calls.push(`retry:${context.attemptNumber}`); return true },
  }, { ...env, onRetry: (context) => { calls.push(`scheduled:${context.attemptNumber}`) } })).rejects.toMatchObject({ cause: source })
  expect(calls).toEqual(['consume:1:0:1', 'retry:1', 'scheduled:1', 'consume:2:1:0'])
})

test.each(['consume', 'retry', 'scheduled'] as const)('a %s callback rejection stops retries and preserves its exact foreign value', async (stage) => {
  const thrown = { callback: stage }
  let calls = 0
  const execution = runAttempt(async () => { calls += 1; throw new Error('source') }, {
    ...immediate,
    shouldConsumeRetry: async () => { if (stage === 'consume') throw thrown; return true },
    shouldRetry: async () => { if (stage === 'retry') throw thrown; return true },
  }, { ...env, onRetry: async () => { if (stage === 'scheduled') throw thrown } })
  await expect(execution).rejects.toBe(thrown)
  expect(calls).toBe(1)
})

test('non-consuming failures retain retry counters and do not wait for exponential backoff', async () => {
  const counters: number[][] = []
  const result = await runAttempt(async (attempt) => {
    if (attempt < 4) throw new Error('temporary')
    return attempt
  }, {
    retries: 1, minTimeout: 60_000,
    shouldConsumeRetry: ({ attemptNumber, retriesConsumed, retriesLeft }) => {
      counters.push([attemptNumber, retriesConsumed, retriesLeft])
      return false
    },
  }, env)
  expect(result).toBe(4)
  expect(counters).toEqual([[1, 0, 1], [2, 0, 1], [3, 0, 1]])
}, 1000)

test('an exhausted time budget rejects before invoking retry policy callbacks', async () => {
  let callbacks = 0
  await expect(runAttempt(async () => { throw new Error('no time') }, {
    ...immediate, maxRetryTime: 0,
    shouldConsumeRetry: () => { callbacks += 1; return true },
    shouldRetry: () => { callbacks += 1; return true },
  }, { ...env, onRetry: () => { callbacks += 1 } })).rejects.toBeInstanceOf(FetchFailure)
  expect(callbacks).toBe(0)
})

test('retry delay is capped by the remaining time budget and still permits the already-approved attempt', async () => {
  let calls = 0
  const result = await runAttempt(async () => {
    calls += 1
    if (calls === 1) throw new Error('temporary')
    return 'ok'
  }, { minTimeout: 60_000, randomize: false, maxRetryTime: 25 }, env)
  expect(result).toBe('ok')
  expect(calls).toBe(2)
}, 1000)

test('time spent consuming a retry is charged before deciding whether to schedule it', async () => {
  let scheduled = 0
  let calls = 0
  await expect(runAttempt(async () => { calls += 1; throw new Error('provider') }, {
    ...immediate, maxRetryTime: 10,
    shouldConsumeRetry: async () => { await sleep(25); return true },
  }, { ...env, onRetry: () => { scheduled += 1 } })).rejects.toBeInstanceOf(FetchFailure)
  expect(calls).toBe(1)
  expect(scheduled).toBe(0)
})

test('Retry-After overlaps rather than adds to exponential backoff', async () => {
  const limited = await HttpError.fromResponse(new Response('', { status: 429, headers: { 'retry-after': '0.4' } }))
  let millis = 0
  const waits: number[] = []
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.sync(() => millis),
    currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(millis) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(millis) * 1_000_000n),
    sleep: (duration) => Effect.sync(() => {
      const delay = Duration.toMillis(duration)
      waits.push(delay)
      millis += delay
    }),
  }
  const result = await runPublic(attemptEffect((attempt) => foreign(async () => {
    if (attempt === 1) throw limited
    return attempt
  }), { retries: 1, minTimeout: 500, randomize: false }, {
    ...env, onRetry: () => Effect.void,
  }).pipe(Effect.provideService(Clock.Clock, clock)))
  expect(result).toBe(2)
  expect(waits).toEqual([500, 0])
  expect(millis).toBe(500)
})

test.each(['consume', 'retry', 'scheduled'] as const)('host cancellation abandons a held %s callback without a second operation', async (stage) => {
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const held = async () => { entered.resolve(); await release.promise; return true }
  const execution = runAttempt(async () => { calls += 1; throw new Error('provider') }, {
    ...immediate,
    shouldConsumeRetry: stage === 'consume' ? held : undefined,
    shouldRetry: stage === 'retry' ? held : undefined,
  }, { ...env, signal: controller.signal, onRetry: stage === 'scheduled' ? async () => { await held() } : env.onRetry })
  await entered.promise
  controller.abort(new Error('host stopped'))
  await expect(execution).rejects.toThrow('host stopped')
  release.resolve()
  await sleep(0)
  expect(calls).toBe(1)
})
