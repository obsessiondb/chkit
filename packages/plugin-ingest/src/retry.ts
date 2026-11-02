import pRetry, { AbortError } from 'p-retry'

import { classifyFailure, FetchFailure } from './errors.js'
import type { ErrorClassifier, FailureClass, RetryContext, RetryOptions } from './types.js'

const DEFAULT_RETRY = {
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

/**
 * p-retry owns retry budgets and backoff; this adapter adds provider classification.
 * The caller waits out a provider's Retry-After, which `onRetry` reports.
 */
export function runAttempt<T>(
  operation: (attemptNumber: number) => Promise<T>,
  policy: RetryOptions,
  env: AttemptEnv
): Promise<T> {
  const options = { ...DEFAULT_RETRY, ...mergeRetry(policy) }
  const deadline = performance.now() + options.maxRetryTime

  return pRetry(async (attemptNumber) => {
    env.signal.throwIfAborted()
    try {
      return await operation(attemptNumber)
    } catch (cause) {
      const failure = new FetchFailure(cause, classifyFailure(cause, env.signal, env.classifier))
      if (!isTransient(failure.classification)) throw new AbortError(failure)
      throw failure
    }
  }, {
    ...options,
    signal: env.signal,
    shouldConsumeRetry: ({ error, ...context }) =>
      error instanceof FetchFailure ? (policy.shouldConsumeRetry?.({ ...context, error }) ?? !isScheduledByProvider(error.classification, options.minTimeout)) : true,
    shouldRetry: async ({ error, ...context }) => {
      env.signal.throwIfAborted()
      if (!(error instanceof FetchFailure)) return false
      const retryContext = { ...context, error }
      if (policy.shouldRetry && !(await policy.shouldRetry(retryContext))) return false
      const retryAfterMs = error.classification.kind === 'rate_limited' ? error.classification.retryAfterMs : undefined
      if (performance.now() + (retryAfterMs ?? 0) > deadline) return false
      await env.onRetry(retryContext, retryAfterMs)
      return true
    },
  }).catch((error: unknown) => {
    throw error instanceof FetchFailure ? error.cause : error
  })
}

function isScheduledByProvider(classification: FailureClass, minTimeout: number): boolean {
  return classification.kind === 'rate_limited' && classification.retryAfterMs !== undefined && classification.retryAfterMs >= minTimeout
}

function isTransient(classification: FailureClass): boolean {
  return classification.kind === 'transient' || classification.kind === 'rate_limited'
}
