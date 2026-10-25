import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { fromPromise, runEffect } from '../effect-runtime.js'
import { getBackfillLogger } from '../logging.js'
import { timedPlannerQuery } from './query-runtime.js'
import { generateChunkPlanEffect } from './plan-runtime.js'
import { buildRootSlice } from './partition-slices.js'
import { splitSliceWithQuantiles } from './strategies/quantile-range-split.js'
import { refinePartitionSlices } from './strategies/refinement.js'
import type { Partition, PlannerContext, SortKey } from './types.js'

afterEach(() => mock.restore())

const partition: Partition = {
  partitionId: 'all',
  rows: 1000,
  bytesCompressed: 1000,
  bytesUncompressed: 1000,
  minTime: '2024-01-01T00:00:00Z',
  maxTime: '2024-01-02T00:00:00Z',
}
const keys: SortKey[] = [{ name: 'id', type: 'UInt64', category: 'numeric', boundaryEncoding: 'literal' }]

test.each([
  'quantiles',
  'refinement',
] as const)('%s holds bounded probe slots through the query response', async (strategy) => {
  const release = Promise.withResolvers<void>()
  const atCapacity = Promise.withResolvers<void>()
  let active = 0
  let peak = 0
  let started = 0
  const context: PlannerContext = {
    database: 'test',
    table: 'events',
    rowProbeStrategy: strategy === 'refinement' ? 'explain-estimate' : 'count',
    targetChunkBytes: 1,
    async query<T>(): Promise<T[]> {
      started++
      active++
      peak = Math.max(peak, active)
      if (active === 50) atCapacity.resolve()
      await release.promise
      active--
      return [{ cnt: '1' }] as T[]
    },
  }
  const slice = buildRootSlice(partition)
  const run =
    strategy === 'quantiles'
      ? runEffect(
          splitSliceWithQuantiles(
            context,
            partition,
            slice,
            keys,
            0,
            Array.from({ length: 52 }, (_, index) => String(index)),
          ),
        )
      : runEffect(
          refinePartitionSlices(
            context,
            partition,
            Array.from({ length: 51 }, () => slice),
            keys,
            false,
          ),
        )
  await atCapacity.promise
  expect(started).toBe(50)
  release.resolve()
  await run
  expect(started).toBe(51)
  expect(peak).toBe(50)
  expect(active).toBe(0)
})

test.each(['success', 'failure'] as const)('query warnings stop when the query settles with %s', async (outcome) => {
  const warning = spyOn(getBackfillLogger('chunking', 'clickhouse'), 'warning').mockImplementation(async () => {})
  const response = Promise.withResolvers<never[]>()
  const failure = new Error('query rejected')
  await runEffect(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        timedPlannerQuery(
          {
            database: 'test',
            table: 'events',
            query: () => response.promise,
          },
          'SELECT count() AS cnt FROM test.events',
        ),
      )
      yield* TestClock.adjust(4999)
      expect(warning).not.toHaveBeenCalled()
      yield* TestClock.adjust(1)
      expect(warning).toHaveBeenCalledTimes(1)
      yield* TestClock.adjust(5000)
      expect(warning).toHaveBeenCalledTimes(2)
      yield* TestClock.adjust(9999)
      expect(warning).toHaveBeenCalledTimes(2)
      yield* TestClock.adjust(1)
      expect(warning).toHaveBeenCalledTimes(3)
      if (outcome === 'success') {
        response.resolve([])
        expect(yield* Fiber.join(fiber)).toEqual([])
      } else {
        response.reject(failure)
        const observed = yield* Effect.flip(Fiber.join(fiber))
        expect(observed).toBe(failure)
      }
      yield* TestClock.adjust(120000)
      expect(warning).toHaveBeenCalledTimes(3)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test('failed probes abandon held sibling observers and preserve the original error', async () => {
  const release = Promise.withResolvers<void>()
  const secondStarted = Promise.withResolvers<void>()
  const failure = new Error('probe rejected')
  let calls = 0
  let finished = false
  const context: PlannerContext = {
    database: 'test',
    table: 'events',
    rowProbeStrategy: 'count',
    targetChunkBytes: 1,
    async query<T>(): Promise<T[]> {
      calls++
      if (calls === 1) {
        await secondStarted.promise
        throw failure
      }
      secondStarted.resolve()
      await release.promise
      finished = true
      return [{ cnt: '1' }] as T[]
    },
  }
  const run = runEffect(
    splitSliceWithQuantiles(context, partition, buildRootSlice(partition), keys, 0, ['0', '1', '2']),
  ).then(
    () => undefined,
    (error: unknown) => error,
  )
  await secondStarted.promise
  const expired = Promise.withResolvers<Error>()
  const timeout = setTimeout(() => expired.resolve(new Error('Probe observer did not abandon')), 1000)
  const observed = await Promise.race([run, expired.promise])
  clearTimeout(timeout)
  expect(finished).toBe(false)
  release.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(observed).toBe(failure)
  expect(await run).toBe(failure)
  expect(finished).toBe(true)
})

test('the private Promise boundary preserves original failures and normalizes interruption', async () => {
  const failure = { code: 'FOREIGN' }
  await expect(
    runEffect(
      fromPromise(() => {
        throw failure
      }),
    ),
  ).rejects.toBe(failure)
  await expect(runEffect(Effect.die(failure))).rejects.toBe(failure)
  await expect(runEffect(Effect.interrupt)).rejects.toThrow(
    'Backfill observation interrupted; server queries may still be running',
  )
})

test('owned resource cleanup preserves finally error precedence', async () => {
  const failure = new Error('operation failed')
  const cleanupFailure = new Error('cleanup failed')
  let releases = 0
  await expect(
    runEffect(
      Effect.acquireUseRelease(
        Effect.succeed('owned'),
        () => Effect.fail(failure),
        () =>
          fromPromise(() => {
            releases++
            throw cleanupFailure
          }),
      ),
    ),
  ).rejects.toBe(cleanupFailure)
  expect(releases).toBe(1)
})

test('abandoned planning closes warning observers and never starts the next metadata query', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  const warning = spyOn(getBackfillLogger('chunking', 'clickhouse'), 'warning').mockImplementation(async () => {})
  const originalSetTimeout = globalThis.setTimeout
  const timerHandles: ReturnType<typeof setTimeout>[] = []
  spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign(
    <Args extends unknown[]>(callback: (...args: Args) => void, delay?: number, ...args: Args): ReturnType<typeof setTimeout> => {
      const handle = originalSetTimeout(callback, delay, ...args)
      if (delay === 5000) timerHandles.push(handle)
      return handle
    },
    { __promisify__: originalSetTimeout.__promisify__ },
  ))
  const clearTimer = spyOn(globalThis, 'clearTimeout')
  let queries = 0
  const run = runEffect(
    generateChunkPlanEffect({
      database: 'test',
      table: 'events',
      targetChunkBytes: 1,
      async query<T>(): Promise<T[]> {
        queries++
        entered.resolve()
        await release.promise
        return []
      },
    }),
    controller.signal,
  ).then(
    () => undefined,
    (error: unknown) => error,
  )
  await entered.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  controller.abort()
  const observed = await run
  release.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(observed).toBeInstanceOf(Error)
  expect(String(observed)).toContain('Backfill observation interrupted')
  expect(queries).toBe(1)
  expect(timerHandles).toHaveLength(1)
  expect(clearTimer).toHaveBeenCalledWith(timerHandles[0])
  expect(warning).not.toHaveBeenCalled()
})
