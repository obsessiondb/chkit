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

export async function run<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  const result = await runExit(program)
  if (result._tag === 'Success') return result.value
  for (const reason of result.cause.reasons.slice().reverse()) {
    if (reason._tag === 'Fail') throw reason.error
    if (reason._tag === 'Die') throw reason.defect
  }
  throw new DOMException('The operation was aborted', 'AbortError')
}

export function attempt<A>(operation: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.withFiber((fiber) => {
    const scope = Context.getOption(fiber.context, Scope.Scope)
    if (Option.isSome(scope) && scope.value.state._tag === 'Closed') return Effect.scoped(attempt(operation))
    const owner = ownerFor(fiber.context)
    return Effect.tryPromise({
      try: () => owner ? execution.run(owner, operation) : operation(),
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
