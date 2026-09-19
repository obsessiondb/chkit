import { describe, expect, test } from 'bun:test'

import { FetchFailure, HttpError, IngestConfigError } from './errors.js'
import { runAttempt } from './retry.js'
import type { RetryContext } from './types.js'

const signal = new AbortController().signal
const env = { signal, classifier: undefined, onRetry: () => undefined }
const immediate = { minTimeout: 0, randomize: false }
const httpError = (status: number, retryAfter = '0') =>
  HttpError.fromResponse(new Response('', { status, headers: { 'retry-after': retryAfter } }))

describe('provider retry policy', () => {
  test('honors Retry-After even when rate limits do not consume the retry budget', async () => {
    const limited = await httpError(429, '0.03')
    const transient = await httpError(503)
    const retries: RetryContext[] = []
    const times: number[] = []
    const value = await runAttempt(async (attempt) => {
      times.push(performance.now())
      if (attempt === 1) throw limited
      if (attempt === 2) throw transient
      return 'ok'
    }, {
      ...immediate,
      retries: 1,
      shouldConsumeRetry: ({ error }) => error.classification.kind !== 'rate_limited',
    }, { ...env, onRetry: (context) => { retries.push(context) } })

    expect(value).toBe('ok')
    expect(times).toHaveLength(3)
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(25)
    expect(retries.map(({ attemptNumber, retriesLeft, retriesConsumed }) => ({ attemptNumber, retriesLeft, retriesConsumed }))).toEqual([
      { attemptNumber: 1, retriesLeft: 1, retriesConsumed: 0 },
      { attemptNumber: 2, retriesLeft: 1, retriesConsumed: 0 },
    ])
    expect(retries[0]?.error.cause).toBe(limited)
  })

  test('does not schedule a retry when Retry-After exceeds maxRetryTime', async () => {
    let calls = 0
    let scheduled = 0
    const failure = await httpError(429, '60')
    await expect(runAttempt(async () => {
      calls += 1
      throw failure
    }, { ...immediate, maxRetryTime: 100 }, {
      ...env, onRetry: () => { scheduled += 1 },
    })).rejects.toMatchObject({ cause: failure })
    expect(calls).toBe(1)
    expect(scheduled).toBe(0)
  })

  test.each(['backoff', 'retry-after'] as const)('cancellation interrupts %s without calling the provider again', async (mode) => {
    const controller = new AbortController()
    const failure = await httpError(mode === 'backoff' ? 503 : 429, '60')
    let calls = 0
    const timer = setTimeout(() => controller.abort(new Error('cancelled')), 20)
    try {
      await expect(runAttempt(async () => {
        calls += 1
        throw failure
      }, { minTimeout: mode === 'backoff' ? 60_000 : 0 }, { ...env, signal: controller.signal })).rejects.toThrow()
      expect(calls).toBe(1)
    } finally {
      clearTimeout(timer)
    }
  })

  test('preserves the thrown value and allows the retry veto', async () => {
    const cause = { providerCode: 'NO_ACCESS' }
    let calls = 0
    await expect(runAttempt(async () => {
      calls += 1
      throw cause
    }, { ...immediate, shouldRetry: ({ error }) => error.cause !== cause }, env)).rejects.toMatchObject({ cause })
    expect(calls).toBe(1)
  })

  test('does not retry permanent, configuration, or already-exhausted source failures', async () => {
    const exhausted = new FetchFailure(new Error('already retried'), { kind: 'transient' })
    for (const cause of [await httpError(401), new IngestConfigError('invalid'), exhausted]) {
      let calls = 0
      await expect(runAttempt(async () => {
        calls += 1
        throw cause
      }, immediate, env)).rejects.toThrow()
      expect(calls).toBe(1)
    }
  })
})
