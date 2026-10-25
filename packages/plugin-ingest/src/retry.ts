import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import isNetworkError from 'is-network-error'

import { classifyFailure, FetchFailure, IngestConfigError } from './errors.js'
import { abortOn, foreign, runPublic, sync } from './runtime.js'
import type { ErrorClassifier, RetryContext, RetryOptions } from './types.js'

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

interface RetryState {
  error: Error
  attemptNumber: number
  retriesLeft: number
  retriesConsumed: number
}

interface RetryPolicy extends Pick<RetryOptions, 'retries' | 'factor' | 'minTimeout' | 'maxTimeout' | 'randomize' | 'maxRetryTime'> {
  shouldConsumeRetry?: (context: RetryState) => Effect.Effect<boolean, unknown>
  shouldRetry?: (context: RetryState) => Effect.Effect<boolean, unknown>
}

export class StopRetry {
  constructor(readonly error: unknown) {}
}

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

export function runAttempt<T>(operation: (attemptNumber: number) => Promise<T>, policy: RetryOptions, env: AttemptEnv): Promise<T> {
  return runPublic(attemptEffect((attemptNumber) => foreign(() => operation(attemptNumber)), policy, {
    ...env,
    onRetry: (context, retryAfterMs) => foreign(() => Promise.resolve(env.onRetry(context, retryAfterMs))),
  }))
}

export function attemptEffect<T, R>(
  operation: (attemptNumber: number) => Effect.Effect<T, unknown, R>,
  policy: RetryOptions,
  env: Omit<AttemptEnv, 'onRetry'> & { onRetry: (context: RetryContext, retryAfterMs: number | undefined) => Effect.Effect<void, unknown> }
): Effect.Effect<T, unknown, R> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000
    const options = { ...DEFAULT_RETRY, ...mergeRetry(policy) }
    const deadline = now() + options.maxRetryTime
    let notBefore = 0
    return yield* retryEffect((attemptNumber) => Effect.gen(function* () {
      const remaining = notBefore - now()
      if (remaining > 0) yield* Effect.sleep(remaining)
      return yield* operation(attemptNumber).pipe(Effect.catch((cause) => {
        if (cause instanceof FetchFailure || cause instanceof IngestConfigError) return Effect.fail(new StopRetry(cause))
        return sync(() => new FetchFailure(cause, classifyFailure(cause, env.signal, env.classifier))).pipe(
          Effect.flatMap((failure) => Effect.fail(
            failure.classification.kind === 'cancelled' || failure.classification.kind === 'permanent'
              ? new StopRetry(failure) : failure
          ))
        )
      }))
    }), {
      ...options,
      shouldConsumeRetry: (context) => {
        const { error } = context
        return error instanceof FetchFailure
          ? foreign(() => Promise.resolve(policy.shouldConsumeRetry?.({ ...context, error }) ?? true))
          : Effect.succeed(true)
      },
      shouldRetry: (context) => Effect.gen(function* () {
        yield* sync(() => env.signal.throwIfAborted())
        const { error } = context
        if (!(error instanceof FetchFailure)) return false
        const retryContext = { ...context, error }
        if (policy.shouldRetry && !(yield* foreign(() => Promise.resolve(policy.shouldRetry?.(retryContext))))) return false
        const retryAfterMs = error.classification.kind === 'rate_limited' ? error.classification.retryAfterMs : undefined
        notBefore = now() + (retryAfterMs ?? 0)
        if (notBefore > deadline) return false
        yield* env.onRetry(retryContext, retryAfterMs)
        return true
      }),
    }, env.signal)
  })
}

export function retryEffect<T, R>(
  operation: (attemptNumber: number) => Effect.Effect<T, unknown, R>,
  policy: RetryPolicy,
  signal: AbortSignal
): Effect.Effect<T, unknown, R> {
  return abortOn(Effect.gen(function* () {
    const options = yield* sync(() => resolvePolicy(policy))
    const clock = yield* Clock.Clock
    const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000
    const started = now()
    let attemptNumber = 0
    let retriesConsumed = 0
    const remaining = () => options.maxRetryTime - (now() - started)
    return yield* Effect.suspend(() => {
      if (Number.isFinite(options.retries) && retriesConsumed > options.retries) {
        return Effect.fail(new StopRetry(new Error('Retry attempts exhausted without throwing an error.')))
      }
      attemptNumber += 1
      return operation(attemptNumber).pipe(
        Effect.tap(() => sync(() => signal.throwIfAborted())),
        Effect.mapError(normalizeRetryError)
      )
    }).pipe(
      Effect.retry({
        while: (error) => Effect.gen(function* () {
          if (error instanceof StopRetry) return false
          const retriesLeft = Math.max(0, options.retries - retriesConsumed)
          const context = Object.freeze({ error, attemptNumber, retriesLeft, retriesConsumed })
          if (remaining() <= 0) return false
          const consume = yield* policy.shouldConsumeRetry?.(context) ?? Effect.succeed(true)
          const remainingTime = remaining()
          if (remainingTime <= 0 || retriesLeft <= 0) return false
          if (error instanceof TypeError && !isNetworkError(error)) {
            if (consume) return false
            yield* sync(() => signal.throwIfAborted())
            return true
          }
          if (!(yield* policy.shouldRetry?.(context) ?? Effect.succeed(true))) return false
          yield* sync(() => signal.throwIfAborted())
          if (!consume) return true
          const jitter = options.randomize ? Math.random() + 1 : 1
          const delay = Math.min(Math.round(jitter * options.minTimeout * options.factor ** retriesConsumed), options.maxTimeout, remainingTime)
          if (delay > 0) yield* Effect.sleep(delay)
          yield* sync(() => signal.throwIfAborted())
          retriesConsumed += 1
          return true
        }),
      }),
      Effect.mapError((error) => error instanceof StopRetry ? error.error : error)
    )
  }), signal)
}

function normalizeRetryError(error: unknown): Error | StopRetry {
  if (error instanceof Error && error.name === 'AbortError' && 'originalError' in error && error.originalError instanceof Error) {
    return new StopRetry(error.originalError)
  }
  return error instanceof StopRetry || error instanceof Error
    ? error : new TypeError(`Non-error was thrown: "${String(error)}". You should only throw errors.`)
}

function resolvePolicy(policy: RetryPolicy): Required<Pick<RetryOptions, 'retries' | 'factor' | 'minTimeout' | 'maxTimeout' | 'randomize' | 'maxRetryTime'>> {
  const options = {
    retries: policy.retries ?? 10,
    factor: policy.factor ?? 2,
    minTimeout: policy.minTimeout ?? 1000,
    maxTimeout: policy.maxTimeout ?? Infinity,
    maxRetryTime: policy.maxRetryTime ?? Infinity,
    randomize: policy.randomize ?? false,
  }
  for (const name of ['retries', 'factor', 'minTimeout', 'maxTimeout', 'maxRetryTime'] as const) {
    const value = options[name]
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || ((name === 'factor' || name === 'minTimeout') && !Number.isFinite(value))) {
      throw new TypeError(`Invalid retry option "${name}": expected a non-negative ${name === 'factor' || name === 'minTimeout' ? 'finite ' : ''}number.`)
    }
  }
  if (options.factor === 0) options.factor = 1
  return options
}
