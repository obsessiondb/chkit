import { classifyFailure, FetchFailure } from './errors.js'
import type { Semaphore } from './semaphore.js'
import type { ErrorClassifier, RetryContext, RetryOptions } from './types.js'

export const DEFAULT_RETRY: Required<Omit<RetryOptions, 'shouldRetry' | 'shouldConsumeRetry'>> = {
  retries: 5,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 60_000,
  randomize: true,
  maxRetryTime: 10 * 60_000,
}

export interface AttemptEnv {
  signal: AbortSignal
  fetchPermits: Semaphore
  classifier: ErrorClassifier | undefined
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  random: () => number
  now: () => number
  onAttempt: (input: { label: string; attemptNumber: number }) => Promise<void> | void
  onRetry: (input: { label: string; context: RetryContext }) => Promise<void> | void
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
 * Run one source operation. A fetch permit is acquired per attempt and released
 * while waiting for a retry timer, so backoff never occupies fetch capacity.
 */
export async function runAttempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  label: string,
  policy: RetryOptions,
  env: AttemptEnv
): Promise<T> {
  const retries = policy.retries ?? DEFAULT_RETRY.retries
  const maxRetryTime = policy.maxRetryTime ?? DEFAULT_RETRY.maxRetryTime
  const startedAt = env.now()
  let attemptNumber = 0
  let retriesConsumed = 0

  while (true) {
    attemptNumber += 1
    env.signal.throwIfAborted()
    await env.onAttempt({ label, attemptNumber })

    const release = await env.fetchPermits.acquire(env.signal)
    try {
      return await operation(env.signal)
    } catch (cause) {
      const classification = classifyFailure(cause, env.signal, env.classifier)
      const failure = new FetchFailure(cause, classification)
      if (classification.kind === 'cancelled' || classification.kind === 'permanent') throw failure

      const retriesLeft = retries - retriesConsumed
      const backoff = backoffDelay(policy, retriesConsumed, env.random)
      const hinted = classification.kind === 'rate_limited' ? classification.retryAfterMs : undefined
      const retryDelay = hinted === undefined ? backoff : Math.max(hinted, backoff)
      const context: RetryContext = { error: failure, attemptNumber, retriesLeft, retriesConsumed, retryDelay }

      if (retriesLeft <= 0) throw failure
      if (env.now() - startedAt + retryDelay > maxRetryTime) throw failure
      if (policy.shouldRetry && !(await policy.shouldRetry(context))) throw failure
      const consume = policy.shouldConsumeRetry ? await policy.shouldConsumeRetry(context) : true
      if (consume) retriesConsumed += 1

      await env.onRetry({ label, context })
      release()
      await env.sleep(retryDelay, env.signal)
    } finally {
      release()
    }
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function backoffDelay(policy: RetryOptions, retriesConsumed: number, random: () => number): number {
  const factor = policy.factor ?? DEFAULT_RETRY.factor
  const minTimeout = policy.minTimeout ?? DEFAULT_RETRY.minTimeout
  const maxTimeout = policy.maxTimeout ?? DEFAULT_RETRY.maxTimeout
  const randomize = policy.randomize ?? DEFAULT_RETRY.randomize
  const jitter = randomize ? 1 + random() : 1
  return Math.min(maxTimeout, Math.round(jitter * minTimeout * factor ** retriesConsumed))
}
