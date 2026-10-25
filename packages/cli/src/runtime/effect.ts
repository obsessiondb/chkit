import { AsyncLocalStorage } from 'node:async_hooks'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
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

export function runEffect<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return runExit(program).then((result) => {
    if (result._tag === 'Success') return result.value
    for (const reason of result.cause.reasons.slice().reverse()) {
      if (reason._tag === 'Fail') throw reason.error
      if (reason._tag === 'Die') throw reason.defect
    }
    throw new Error('CLI execution is no longer active.')
  })
}

export function fromPromise<A>(fn: (signal: AbortSignal) => PromiseLike<A> | A): Effect.Effect<A, unknown> {
  return Effect.withFiber((fiber) => {
    const scope = Context.getOption(fiber.context, Scope.Scope)
    if (Option.isSome(scope) && scope.value.state._tag === 'Closed') return Effect.scoped(fromPromise(fn))
    const owner = ownerFor(fiber.context)
    return Effect.tryPromise({
      try: (signal) => Promise.resolve(owner ? execution.run(owner, () => fn(signal)) : fn(signal)),
      catch: (error) => error,
    })
  })
}

export function bindExecution<Args extends unknown[], A>(
  fn: (...args: Args) => Promise<A>,
): Effect.Effect<(...args: Args) => Promise<A>> {
  return Effect.withFiberSucceed((fiber) => {
    const owner = ownerFor(fiber.context)
    return (...args: Args): Promise<A> => owner ? execution.run(owner, () => fn(...args)) : fn(...args)
  })
}

export function ensuring<A, E, R, R2>(
  effect: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<unknown, unknown, R2>,
): Effect.Effect<A, unknown, R | R2> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(restore(effect))
      const closing = yield* Effect.forkChild(Effect.interruptible(cleanup), { startImmediately: true })
      const finishInterrupted = Effect.gen(function* () {
        const finished = yield* Fiber.await(closing).pipe(Effect.interruptible, Effect.timeoutOption(5_000))
        if (Option.isSome(finished)) return yield* finished.value
        yield* Fiber.interrupt(closing)
      })
      if (Exit.hasInterrupts(result)) {
        yield* finishInterrupted
      } else {
        yield* restore(Fiber.join(closing)).pipe(Effect.onInterrupt(() => finishInterrupted))
      }
      return yield* result
    }),
  )
}

export function scopedExecution<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.scoped(effect)
}

function runExit<A, E>(program: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  const owner = execution.getStore()
  return owner ? owner.run(program) : Effect.runPromiseExit(Effect.scoped(program))
}

function ownerFor(services: Context.Context<never>): ExecutionOwner | undefined {
  const scope = Context.getOption(services, Scope.Scope)
  if (Option.isNone(scope)) return undefined
  return {
    run: (program) => new Promise((resolve) => {
      const fiber = Effect.runSyncWith(services)(Effect.forkIn(program, scope.value))
      fiber.addObserver(resolve)
    }),
  }
}
