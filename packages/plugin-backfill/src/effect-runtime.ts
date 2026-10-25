import { AsyncLocalStorage } from 'node:async_hooks'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import type * as Exit from 'effect/Exit'
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

export async function runEffect<A, E>(program: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
  const observed = signal ? Effect.suspend(() => signal.aborted ? Effect.interrupt : Effect.raceFirst(
    program,
    Effect.callback<never>((resume) => {
      const interrupt = () => resume(Effect.interrupt)
      signal.addEventListener('abort', interrupt, { once: true })
      return Effect.sync(() => signal.removeEventListener('abort', interrupt))
    }),
  )) : program
  const result = await runExit(observed)
  if (result._tag === 'Success') return result.value
  for (const reason of result.cause.reasons.slice().reverse()) {
    if (reason._tag === 'Fail') throw reason.error
    if (reason._tag === 'Die') throw reason.defect
  }
  throw new Error('Backfill observation interrupted; server queries may still be running. Resume to reconcile their status.')
}

export function fromPromise<A>(operation: () => PromiseLike<A> | A): Effect.Effect<A, unknown> {
  return Effect.withFiber((fiber) => {
    const scope = Context.getOption(fiber.context, Scope.Scope)
    if (Option.isSome(scope) && scope.value.state._tag === 'Closed') return Effect.scoped(fromPromise(operation))
    const owner = ownerFor(fiber.context)
    return Effect.tryPromise({
      try: () => Promise.resolve(owner ? execution.run(owner, operation) : operation()),
      catch: (error) => error,
    })
  })
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
