import { AsyncLocalStorage } from 'node:async_hooks'
import { context, ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Context, type Span } from '@opentelemetry/api'
import * as Cause from 'effect/Cause'
import * as Services from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Scope from 'effect/Scope'

interface ExecutionOwner {
  run<A, E>(program: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>>
}

declare global {
  var __chkitEffectExecutionV4: AsyncLocalStorage<ExecutionOwner> | undefined
}

globalThis.__chkitEffectExecutionV4 ??= new AsyncLocalStorage<ExecutionOwner>()
const execution = globalThis.__chkitEffectExecutionV4

const TelemetryContext = Services.Reference<Context>('chkit/ingest/telemetry', { defaultValue: () => ROOT_CONTEXT })

export async function runPublic<T>(effect: Effect.Effect<T, unknown>): Promise<T> {
  const program = Effect.provideService(effect, TelemetryContext, context.active())
  const owner = execution.getStore()
  const exit = await (owner ? owner.run(program) : Effect.runPromiseExit(Effect.scoped(program)))
  if (Exit.isSuccess(exit)) return exit.value
  throw publicError(exit.cause)
}

export function foreign<T>(operation: () => PromiseLike<T>): Effect.Effect<T, unknown> {
  return Effect.flatMap(TelemetryContext, (active) => Effect.withFiber((fiber) => {
    const scope = Services.getOption(fiber.context, Scope.Scope)
    if (Option.isSome(scope) && scope.value.state._tag === 'Closed') return Effect.scoped(foreign(operation))
    const owner = ownerFor(fiber.context)
    const invoke = () => context.with(active, operation)
    return Effect.tryPromise({
      try: () => owner ? execution.run(owner, invoke) : invoke(), catch: (error) => error,
    })
  }))
}

export function sync<T>(operation: () => T): Effect.Effect<T, unknown> {
  return Effect.flatMap(TelemetryContext, (active) => Effect.withFiber((fiber) => {
    const scope = Services.getOption(fiber.context, Scope.Scope)
    if (Option.isSome(scope) && scope.value.state._tag === 'Closed') return Effect.scoped(sync(operation))
    const owner = ownerFor(fiber.context)
    const invoke = () => context.with(active, operation)
    return Effect.try({
      try: () => owner ? execution.run(owner, invoke) : invoke(), catch: (error) => error,
    })
  }))
}

export function withSpan<T, E, R>(name: string, attributes: Attributes, operation: (span: Span) => Effect.Effect<T, E, R>): Effect.Effect<T, E, R> {
  return Effect.gen(function* () {
    const active = yield* TelemetryContext
    const span = trace.getTracer('@chkit/plugin-ingest').startSpan(name, { attributes }, active)
    return yield* operation(span).pipe(
      Effect.provideService(TelemetryContext, trace.setSpan(active, span)),
      Effect.onExit((exit) => Effect.sync(() => {
        if (Exit.isFailure(exit)) {
          const error = publicError(exit.cause)
          span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
          if (error instanceof Error) span.recordException(error)
        }
        span.end()
      }))
    )
  })
}

export function publicError(cause: Cause.Cause<unknown>, signal?: AbortSignal): unknown {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) return reason.error
    if (Cause.isDieReason(reason)) return reason.defect
  }
  return signal?.reason ?? new DOMException('Ingestion interrupted', 'AbortError')
}

export function abortOn<T, E, R>(effect: Effect.Effect<T, E, R>, signal: AbortSignal): Effect.Effect<T, E | unknown, R> {
  return Effect.suspend(() => signal.aborted
    ? Effect.fail(signal.reason)
    : Effect.raceFirst(effect, aborted(signal)))
}

export function aborted(signal: AbortSignal): Effect.Effect<never, unknown> {
  return Effect.callback((resume) => {
    const onAbort = () => resume(Effect.fail(signal.reason))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', onAbort))
  })
}

export function promiseBridge(signal: AbortSignal): Effect.Effect<
  <T>(effect: Effect.Effect<T, unknown>) => Promise<T>, never, Scope.Scope
> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope
    const services = yield* Effect.context<never>()
    let open = true
    yield* Effect.addFinalizer(() => Effect.sync(() => { open = false }))
    return <T>(effect: Effect.Effect<T, unknown>): Promise<T> => {
      if (!open || signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Reader lifetime ended', 'AbortError'))
      const fiber = Effect.runSyncWith(services)(Effect.forkIn(effect, scope))
      return new Promise<T>((resolve, reject) => {
        fiber.addObserver((exit) => {
          if (Exit.isSuccess(exit)) resolve(exit.value)
          else reject(publicError(exit.cause, signal))
        })
      })
    }
  })
}

function ownerFor(services: Services.Context<never>): ExecutionOwner | undefined {
  const scope = Services.getOption(services, Scope.Scope)
  if (Option.isNone(scope)) return undefined
  return {
    run: (program) => new Promise((resolve) => {
      const fiber = Effect.runSyncWith(services)(Effect.forkIn(program, scope.value))
      fiber.addObserver(resolve)
    }),
  }
}
