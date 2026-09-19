import { setTimeout as sleep } from 'node:timers/promises'

import pRetry, { AbortError } from 'p-retry'

import { classifyFailure, FetchFailure, IngestConfigError } from './errors.js'
import type { ErrorClassifier, RetryContext, RetryOptions } from './types.js'

export const DEFAULT_RETRY = {
  retries: 5,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 60_000,
  randomize: true,
  maxRetryTime: 10 * 60_000,
}

interface AttemptEnv {
  signal: AbortSignal
  classifier: ErrorClassifier | undefined
  onRetry: (context: RetryContext, retryAfterMs: number | undefined) => Promise<void> | void
}

/** Pipeline default, partially overridden by the stream. */
export function mergeRetry(...layers: Array<RetryOptions | undefined>): RetryOptions {
  const merged: RetryOptions = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) Object.assign(merged, { [key]: value })
    }
  }
  return merged
}

/** p-retry owns retry budgets and backoff; this adapter adds provider classification and Retry-After. */
export function runAttempt<T>(
  operation: (attemptNumber: number) => Promise<T>,
  policy: RetryOptions,
  env: AttemptEnv
): Promise<T> {
  const options = { ...DEFAULT_RETRY, ...mergeRetry(policy) }
  const deadline = performance.now() + options.maxRetryTime
  let notBefore = 0

  return pRetry(async (attemptNumber) => {
    // Backoff and Retry-After overlap: only wait out the remaining provider embargo.
    const remaining = notBefore - performance.now()
    if (remaining > 0) await sleep(remaining, undefined, { signal: env.signal })
    env.signal.throwIfAborted()
    try {
      return await operation(attemptNumber)
    } catch (cause) {
      // A nested source attempt already exhausted its retries. Never replay it
      // through the reader's coarser retry boundary.
      if (cause instanceof FetchFailure || cause instanceof IngestConfigError) throw new AbortError(cause)
      const failure = new FetchFailure(cause, classifyFailure(cause, env.signal, env.classifier))
      if (failure.classification.kind === 'cancelled' || failure.classification.kind === 'permanent') throw new AbortError(failure)
      throw failure
    }
  }, {
    ...options,
    signal: env.signal,
    shouldConsumeRetry: ({ error, ...context }) =>
      error instanceof FetchFailure ? (policy.shouldConsumeRetry?.({ ...context, error }) ?? true) : true,
    shouldRetry: async ({ error, ...context }) => {
      env.signal.throwIfAborted()
      if (!(error instanceof FetchFailure)) return false
      const retryContext = { ...context, error }
      if (policy.shouldRetry && !(await policy.shouldRetry(retryContext))) return false
      const retryAfterMs = error.classification.kind === 'rate_limited' ? error.classification.retryAfterMs : undefined
      notBefore = performance.now() + (retryAfterMs ?? 0)
      if (notBefore > deadline) return false
      await env.onRetry(retryContext, retryAfterMs)
      return true
    },
  })
}
