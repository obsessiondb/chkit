import { expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import { attempt, run } from './effect-runtime.js'
import { waitForRows } from './ddl-propagation.js'
import type { ClickHouseExecutor } from './index.js'

test('public Promise boundaries retain ordinary failures and defects', async () => {
  const foreign = new Error('foreign failure')
  const defect = new TypeError('programmer failure')
  await expect(run(Effect.fail(foreign))).rejects.toBe(foreign)
  await expect(run(Effect.die(defect))).rejects.toBe(defect)
  await expect(run(Effect.interrupt)).rejects.toMatchObject({ name: 'AbortError', message: 'The operation was aborted' })
})

test('cleanup failure retains finally precedence without exposing a Cause', async () => {
  const primary = new Error('command failed')
  const cleanup = new Error('close failed')
  await expect(run(Effect.acquireUseRelease(
    Effect.void,
    () => Effect.fail(primary),
    () => Effect.fail(cleanup),
  ))).rejects.toBe(cleanup)
})

test('foreign finalizers can await another owned public API while their resource scope closes', async () => {
  let closed = 0
  await run(Effect.scoped(Effect.acquireRelease(
    Effect.void,
    () => attempt(() => run(Effect.sync(() => { closed += 1 }))).pipe(Effect.orDie),
  )))
  expect(closed).toBe(1)
})

test('catalog retry preserves ordinary TypeErrors and does not retry them', async () => {
  let attempts = 0
  const original = new TypeError('invalid custom query')
  const executor = queryExecutor(async () => { attempts += 1; throw original })
  await expect(waitForRows(executor, 'SELECT 1', () => true)).rejects.toBe(original)
  expect(attempts).toBe(1)
})

test('catalog retry preserves network TypeError recovery', async () => {
  let attempts = 0
  const executor = queryExecutor(async () => {
    attempts += 1
    if (attempts === 1) throw new TypeError('fetch failed')
  })
  await expect(waitForRows(executor, 'SELECT 1', () => true)).resolves.toEqual([])
  expect(attempts).toBe(2)
})

test('catalog retry preserves non-Error normalization and legacy abort errors', async () => {
  const nonError = queryExecutor(async () => { throw 'foreign rejection' })
  await expect(waitForRows(nonError, 'SELECT 1', () => true)).rejects.toThrow('Non-error was thrown: "foreign rejection". You should only throw errors.')
  const original = new Error('do not retry')
  const abort = Object.assign(new Error('do not retry'), { name: 'AbortError', originalError: original })
  let attempts = 0
  const aborted = queryExecutor(async () => { attempts += 1; throw abort })
  await expect(waitForRows(aborted, 'SELECT 1', () => true)).rejects.toBe(original)
  expect(attempts).toBe(1)
})

function queryExecutor(query: () => Promise<void>): ClickHouseExecutor {
  return {
    async query<T>(): Promise<T[]> { await query(); return [] },
    async command() {},
    async insert() {},
    async listSchemaObjects() { return [] },
    async listTableDetails() { return [] },
    async submit() { return 'query' },
    async queryStatus() { return { status: 'unknown' } },
    async close() {},
  }
}
