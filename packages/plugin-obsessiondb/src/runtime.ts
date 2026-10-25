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

export async function runEffect<A>(program: Effect.Effect<A, unknown>): Promise<A> {
  const result = await runExit(program)
  if (result._tag === 'Success') return result.value
  throw failureValue(result.cause)
}

export function fromPromise<A>(operation: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.withFiber((fiber) => {
    const scope = Context.getOption(fiber.context, Scope.Scope)
    if (Option.isSome(scope) && scope.value.state._tag === 'Closed') return Effect.scoped(fromPromise(operation))
    const owner = ownerFor(fiber.context)
    return Effect.tryPromise({
      try: (signal) => owner ? execution.run(owner, () => operation(signal)) : operation(signal),
      catch: (error) => error,
    })
  })
}

export function failureValue(cause: import('effect/Cause').Cause<unknown>): unknown {
  for (const reason of cause.reasons.slice().reverse()) {
    if (reason._tag === 'Fail') return reason.error
    if (reason._tag === 'Die') return reason.defect
  }
  return new DOMException('ObsessionDB operation interrupted.', 'AbortError')
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
