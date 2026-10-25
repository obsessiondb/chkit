import { expect, test } from 'bun:test'
import { setImmediate } from 'node:timers/promises'
import * as Effect from 'effect/Effect'
import { runEffect as cliRun, fromPromise as cliForeign } from '../../runtime/effect.js'
import { run as clickhouseRun, attempt as clickhouseForeign } from '../../../../clickhouse/src/effect-runtime.js'
import { run as codegenRun, attempt as codegenForeign } from '../../../../codegen/src/effect-runtime.js'
import { run as createRun, attempt as createForeign } from '../../../../create-chkit/src/effect-runtime.js'
import { run as pluginCodegenRun, attempt as pluginCodegenForeign } from '../../../../plugin-codegen/src/effect-runtime.js'
import { run as pullRun, attempt as pullForeign } from '../../../../plugin-pull/src/effect-runtime.js'
import { runEffect as backfillRun, fromPromise as backfillForeign } from '../../../../plugin-backfill/src/effect-runtime.js'
import { runEffect as obsessionRun, fromPromise as obsessionForeign } from '../../../../plugin-obsessiondb/src/runtime.js'
import { runPublic as ingestRun, foreign as ingestForeign } from '../../../../plugin-ingest/src/runtime.js'

interface Adapter {
  name: string
  run<A>(program: Effect.Effect<A, unknown>): Promise<A>
  foreign<A>(operation: () => Promise<A>): Effect.Effect<A, unknown>
}
const adapters: Adapter[] = [
  { name: 'cli', run: cliRun, foreign: cliForeign },
  { name: 'clickhouse', run: clickhouseRun, foreign: clickhouseForeign },
  { name: 'codegen', run: codegenRun, foreign: codegenForeign },
  { name: 'create-chkit', run: createRun, foreign: createForeign },
  { name: 'plugin-codegen', run: pluginCodegenRun, foreign: pluginCodegenForeign },
  { name: 'pull', run: pullRun, foreign: pullForeign },
  { name: 'backfill', run: backfillRun, foreign: backfillForeign },
  { name: 'obsessiondb', run: obsessionRun, foreign: obsessionForeign },
  { name: 'ingest', run: ingestRun, foreign: ingestForeign },
]
for (const outer of adapters) for (const inner of adapters) test(`${outer.name} owns ${inner.name} runtime calls`, async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let continued = false
  let child: Promise<unknown> | undefined
  await outer.run(outer.foreign(async () => {
    await setImmediate()
    child = inner.run(Effect.gen(function* () {
      yield* inner.foreign(async () => { entered.resolve(); await release.promise })
      continued = true
    }))
    void child.catch(() => undefined)
    await entered.promise
  }))
  expect(child).toBeDefined()
  await expect(child).rejects.toBeInstanceOf(Error)
  release.resolve()
  await setImmediate()
  expect(continued).toBe(false)

  let closed = 0
  await outer.run(Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.void, () => outer.foreign(async () => {
      await setImmediate()
      await inner.run(Effect.sync(() => { closed++ }))
    }).pipe(Effect.orDie))
  })))
  expect(closed).toBe(1)

  const later = Promise.withResolvers<void>()
  const late = Promise.withResolvers<unknown>()
  let lateRan = false
  await outer.run(outer.foreign(async () => {
    void (async () => {
      await later.promise
      return inner.run(Effect.sync(() => { lateRan = true }))
    })().then(late.resolve, late.resolve)
  }))
  later.resolve()
  expect(await late.promise).toBeInstanceOf(Error)
  expect(lateRan).toBe(false)

  const original = new Error('foreign identity')
  await expect(outer.run(outer.foreign(async () => {
    await setImmediate()
    return inner.run(Effect.fail(original))
  }))).rejects.toBe(original)
})
