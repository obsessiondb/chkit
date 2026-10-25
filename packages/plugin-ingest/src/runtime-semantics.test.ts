import { expect, test } from 'bun:test'
import { setImmediate } from 'node:timers/promises'

import { table } from '@chkit/core'

import { ingestionColumns } from './destination.js'
import { runIngestion, type ExecutionEnv } from './executor.js'
import { cursorState } from './incremental.js'
import { simpleLoader } from './loader.js'
import { definePipeline, defineStream, selectStreams } from './registry.js'
import { createMemoryDestination, createMemoryJournal } from './testing.js'
import type { FetchContext, PipelineDefinition } from './types.js'

const destinationTable = table({
  database: 'test', name: 'events', columns: [{ name: 'id', type: 'UInt64' }, ...ingestionColumns],
  engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'],
})

test.each([1, 2, 4])('blocked sink bounds actual pull-ahead to prefetch %i plus two batches', async (prefetchBatches) => {
  const started = deferred<void>()
  const release = deferred<void>()
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const insert = destination.insert.bind(destination)
  destination.insert = async (batch) => {
    started.resolve()
    await release.promise
    await insert(batch)
  }
  let pulls = 0
  const stream = defineStream({
    id: 'pulls', destination: destinationTable, batchSize: 1,
    incremental: cursorState<number>({ id: 'number', version: 1, parse: (value) => Number(value) }),
    async *read() {
      for (let id = 0; id < 12; id += 1) {
        pulls += 1
        yield { rows: [{ id }], state: id + 1, id: String(id) }
      }
    },
  })
  const execution = run(definePipeline({ id: 'pipeline', streams: [stream] }), { journal, destination, prefetchBatches })
  await started.promise
  await setImmediate()
  expect(pulls).toBe(prefetchBatches + 2)
  expect(journal.events.filter((event) => event.eventKind === 'batch_committed')).toHaveLength(0)
  release.resolve()
  const result = await execution
  expect(result.ok).toBe(true)
  expect(result.streams[0]?.rows).toBe(12)
  expect((await journal.readCheckpoint('pulls')).envelope?.state).toBe(12)
})

test.each([NaN, Infinity, -Infinity, 0, -1, 1.5])('rejects non-finite or invalid programmatic capacities %s before IO', async (value) => {
  const stream = defineStream({ id: 'capacity', destination: destinationTable, async *read() { yield { rows: [] } } })
  const pipeline = definePipeline({ id: 'pipeline', streams: [stream] })
  const journal = createMemoryJournal()
  let calls = 0
  journal.ensure = async () => { calls += 1 }
  const env = { journal, destination: createMemoryDestination() }
  await expect(run(pipeline, { ...env, prefetchBatches: value })).rejects.toThrow('prefetchBatches')
  for (const key of ['maxStreams', 'maxFetches', 'maxLoads'] as const) {
    await expect(run({ ...pipeline, [key]: value }, env)).rejects.toThrow(key)
  }
  await expect(run({ ...pipeline, streams: [{ ...stream, batchSize: value }] }, env)).rejects.toThrow('batchSize')
  for (const key of ['maxChunkRows', 'maxChunks'] as const) {
    await expect(run({ ...pipeline, streams: [{ ...stream, budget: { [key]: value } }] }, env)).rejects.toThrow(key)
  }
  expect(() => simpleLoader({ maxRowsPerInsert: value })).toThrow('maxRowsPerInsert')
  expect(calls).toBe(0)
})

test.each([NaN, Infinity, -Infinity, 0, -1])('rejects invalid duration %s before IO', async (maxDurationMs) => {
  const journal = createMemoryJournal()
  await expect(run(definePipeline({ id: 'pipeline', streams: [] }), {
    journal, destination: createMemoryDestination(), maxDurationMs,
  })).rejects.toThrow('maxDurationMs')
  expect(journal.events).toHaveLength(0)
})

test('retained attempt capabilities reject after their reader lifetime and never start work', async () => {
  let attempt: FetchContext['attempt'] = () => Promise.reject(new Error('reader did not start'))
  let calls = 0
  const stream = defineStream({
    id: 'retained', destination: destinationTable,
    async *read(context) { attempt = context.attempt; yield { rows: [{ id: 1 }] } },
  })
  const result = await run(definePipeline({ id: 'pipeline', streams: [stream] }), {
    journal: createMemoryJournal(), destination: createMemoryDestination(),
  })
  expect(result.ok).toBe(true)
  await expect(attempt(async () => { calls += 1; return 1 })).rejects.toThrow('Reader lifetime ended')
  expect(calls).toBe(0)
})

test('unawaited attempts are owned by the reader scope and cannot retry or publish after success', async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  const attemptResult = deferred<unknown>()
  const journal = createMemoryJournal()
  let operationSignal: AbortSignal | undefined
  let requests = 0
  const stream = defineStream({
    id: 'owned', destination: destinationTable, retry: { minTimeout: 0, retries: 5 },
    async *read(context) {
      void context.attempt(async (signal) => {
        requests += 1
        operationSignal = signal
        started.resolve()
        await release.promise
        throw new Error('late foreign rejection')
      }).then(attemptResult.resolve, attemptResult.resolve)
      await started.promise
      yield { rows: [{ id: 1 }] }
    },
  })
  const result = await run(definePipeline({ id: 'pipeline', streams: [stream] }), { journal, destination: createMemoryDestination() })
  expect(result.ok).toBe(true)
  expect(operationSignal?.aborted).toBe(true)
  expect(await attemptResult.promise).toBeInstanceOf(DOMException)
  const events = journal.events.length
  release.resolve()
  await setImmediate()
  expect(requests).toBe(1)
  expect(journal.events).toHaveLength(events)
  expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled')).toHaveLength(0)
})

test.each(['next', 'write', 'finalize', 'return'] as const)('abandons an ordinary held %s without late checkpoints or progress', async (stage) => {
  const started = deferred<void>()
  const release = deferred<void>()
  const controller = new AbortController()
  const journal = createMemoryJournal()
  let returned = 0
  let finalized = 0
  let aborted = 0
  let pulled = 0
  const stream = defineStream({
    id: 'held', destination: destinationTable,
    read() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              pulled += 1
              if (stage === 'next') { started.resolve(); await release.promise }
              return pulled === 1 ? { done: false as const, value: { rows: [{ id: 1 }] } } : { done: true as const, value: undefined }
            },
            async return() {
              returned += 1
              if (stage === 'return') await release.promise
              return { done: true as const, value: undefined }
            },
          }
        },
      }
    },
    loader: (ctx) => ({
      ctx,
      async write() {
        if (stage === 'write' || stage === 'return') { started.resolve(); await release.promise }
      },
      async finalize() {
        finalized += 1
        if (stage === 'finalize') { started.resolve(); await release.promise }
        return { evidence: 'clickhouse_ack', rows: 1, writeUnits: 1 }
      },
      async abort() { aborted += 1 },
    }),
  })
  const execution = run(definePipeline({ id: 'pipeline', streams: [stream] }), {
    journal, destination: createMemoryDestination(), signal: controller.signal,
  })
  await started.promise
  controller.abort(new Error('host stopped'))
  const result = await execution
  expect(result.streams[0]?.outcome).toBe('cancelled')
  expect(result.streams[0]?.rows).toBe(0)
  expect(returned).toBe(1)
  expect(aborted).toBe(stage === 'next' ? 0 : 1)
  const count = journal.events.length
  release.resolve()
  await setImmediate()
  expect(journal.events).toHaveLength(count)
  expect(journal.events.filter((event) => event.eventKind === 'batch_committed')).toHaveLength(0)
  expect(finalized).toBe(stage === 'finalize' ? 1 : 0)
})

test('a hung loader abort is bounded and preserves the write error', async () => {
  const release = deferred<void>()
  let cleanup = 0
  const stream = defineStream({
    id: 'cleanup', destination: destinationTable, retry: { retries: 0 },
    async *read() { yield { rows: [{ id: 1 }] } },
    loader: (ctx) => ({
      ctx, async write() { throw new TypeError('invalid sink payload') },
      async finalize() { return { evidence: 'clickhouse_ack', rows: 1, writeUnits: 1 } },
      async abort() { cleanup += 1; await release.promise },
    }),
  })
  const result = await run(definePipeline({ id: 'pipeline', streams: [stream] }), {
    journal: createMemoryJournal(), destination: createMemoryDestination(),
  })
  expect(result.streams[0]?.outcome).toBe('failed')
  expect(result.streams[0]?.error).toBe('invalid sink payload')
  expect(cleanup).toBe(1)
  release.resolve()
}, 7000)

test('released logical permits do not imply cancellation of foreign remote writes', async () => {
  const firstWrite = deferred<void>()
  const release = deferred<void>()
  const journal = createMemoryJournal()
  let remoteActive = 0
  let peakRemote = 0
  let firstSignal: AbortSignal | undefined
  const failed = defineStream({
    id: 'failed', destination: destinationTable, batchSize: 1, retry: { retries: 0 },
    async *read() {
      yield { rows: [{ id: 1 }], id: 'first' }
      await firstWrite.promise
      throw new Error('reader failed')
    },
    loader: (ctx) => ({
      ctx,
      async write() {
        firstSignal = ctx.signal
        remoteActive += 1
        peakRemote = Math.max(peakRemote, remoteActive)
        firstWrite.resolve()
        await release.promise
        remoteActive -= 1
      },
      async finalize() { return { evidence: 'clickhouse_ack', rows: 1, writeUnits: 1 } },
      async abort() {},
    }),
  })
  const succeeded = defineStream({
    id: 'succeeded', destination: destinationTable, batchSize: 1,
    async *read() { await firstWrite.promise; yield { rows: [{ id: 2 }] } },
    loader: (ctx) => ({
      ctx,
      async write() {
        remoteActive += 1
        peakRemote = Math.max(peakRemote, remoteActive)
        remoteActive -= 1
      },
      async finalize() { return { evidence: 'clickhouse_ack', rows: 1, writeUnits: 1 } },
      async abort() {},
    }),
  })
  const result = await run(definePipeline({ id: 'pipeline', streams: [failed, succeeded], maxLoads: 1 }), {
    journal, destination: createMemoryDestination(),
  })
  expect(result.streams.map((stream) => stream.outcome)).toEqual(['failed', 'succeeded'])
  expect(firstSignal?.aborted).toBe(true)
  expect(remoteActive).toBe(1)
  expect(peakRemote).toBe(2)
  const count = journal.events.length
  release.resolve()
  await setImmediate()
  expect(remoteActive).toBe(0)
  expect(journal.events).toHaveLength(count)
  expect(journal.events.filter((event) => event.namespaceId === 'failed' && event.eventKind === 'batch_committed')).toHaveLength(0)
})

test.each([false, true])('reader cleanup preserves synchronous throw and asynchronous rejection behavior (%s)', async (asynchronous) => {
  let returned = 0
  const stream = defineStream({
    id: 'cleanup', destination: destinationTable, retry: { retries: 1, minTimeout: 0, randomize: false },
    read() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() { return { done: true as const, value: undefined } },
            return() {
              returned += 1
              if (asynchronous) return Promise.reject(new Error('reader cleanup failed'))
              throw new Error('reader cleanup failed')
            },
          }
        },
      }
    },
  })
  const result = await run(definePipeline({ id: 'pipeline', streams: [stream] }), {
    journal: createMemoryJournal(), destination: createMemoryDestination(),
  })
  expect(result.streams[0]?.outcome).toBe(asynchronous ? 'succeeded' : 'failed')
  expect(result.streams[0]?.error).toBe(asynchronous ? undefined : 'reader cleanup failed')
  expect(returned).toBe(asynchronous ? 1 : 2)
})

function run(pipeline: PipelineDefinition, env: ExecutionEnv) {
  return runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, env)
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
