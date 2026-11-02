import pRetry, { AbortError } from 'p-retry'

import { classifyFailure, FetchFailure } from './errors.js'
import type { FailureClass, RetryContext, RetryOptions } from './types.js'

const DEFAULT_RETRY = {
  retries: 5,
  minTimeout: 1000,
  maxTimeout: 60_000,
  randomize: true,
  maxRetryTime: 10 * 60_000,
}

interface AttemptEnv {
  signal: AbortSignal
  onRetry: (context: RetryContext, retryAfterMs: number | undefined) => Promise<void> | void
}

/**
 * p-retry owns retry budgets and backoff; this adapter adds failure classification.
 * The caller waits out a provider's Retry-After, which `onRetry` reports.
 */
export function runAttempt<T>(
  operation: (attemptNumber: number) => Promise<T>,
  policy: RetryOptions,
  env: AttemptEnv
): Promise<T> {
  const options = { ...DEFAULT_RETRY, ...definedOptions(policy) }
  const deadline = performance.now() + options.maxRetryTime

  return pRetry(async (attemptNumber) => {
    env.signal.throwIfAborted()
    try {
      return await operation(attemptNumber)
    } catch (cause) {
      const failure = new FetchFailure(cause, classifyFailure(cause, env.signal))
      if (!isTransient(failure.classification)) throw new AbortError(failure)
      throw failure
    }
  }, {
    ...options,
    signal: env.signal,
    shouldConsumeRetry: ({ error }) => !(error instanceof FetchFailure && isScheduledByProvider(error.classification, options.minTimeout)),
    shouldRetry: async ({ error, ...context }) => {
      env.signal.throwIfAborted()
      if (!(error instanceof FetchFailure)) return false
      const retryAfterMs = error.classification.kind === 'rate_limited' ? error.classification.retryAfterMs : undefined
      if (performance.now() + (retryAfterMs ?? 0) > deadline) return false
      await env.onRetry({ ...context, error }, retryAfterMs)
      return true
    },
  }).catch((error: unknown) => {
    throw error instanceof FetchFailure ? error.cause : error
  })
}

function definedOptions(policy: RetryOptions): RetryOptions {
  return Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined))
}

function isScheduledByProvider(classification: FailureClass, minTimeout: number): boolean {
  return classification.kind === 'rate_limited' && classification.retryAfterMs !== undefined && classification.retryAfterMs >= minTimeout
}

function isTransient(classification: FailureClass): boolean {
  return classification.kind === 'transient' || classification.kind === 'rate_limited'
}
