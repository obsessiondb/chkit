import { expect, test } from 'bun:test'
import { setImmediate } from 'node:timers/promises'

import { rawTable } from './destination.js'
import { HttpError } from './errors.js'
import { runIngestion } from './executor.js'
import { cursorState } from './incremental.js'
import { simpleLoader } from './loader.js'
import { definePipeline, defineStream, selectStreams } from './registry.js'
import { createMemoryDestination, createMemoryJournal } from './testing.js'
import type { StreamDefinition } from './types.js'

const destinationTable = rawTable({ database: 'test', name: 'frontiers' })

test('hands off a completed empty interval before a later request fails without completing the whole range', async () => {
  const journal = createMemoryJournal()
  let completed = 0
  const stream = defineStream({
    id: 'frontier', destination: destinationTable, retry: { retries: 0 },
    incremental: {
      ...cursorState({ id: 'frontier', version: 1, parse: Number }),
      complete() { completed += 1; return 99 },
    },
    async *read(context) {
      yield { rows: [], state: 1, id: 'first-completed' }
      await context.attempt(async () => { throw await HttpError.fromResponse(new Response('denied', { status: 403 })) })
    },
  })
  const result = await runIngestion(request(stream), { journal, destination: createMemoryDestination() })
  expect(result.streams[0]?.outcome).toBe('failed')
  expect(result.streams[0]?.error).toContain('HTTP 403')
  expect(result.streams[0]?.checkpointVersion).toBe(1)
  expect((await journal.readCheckpoint('frontier')).envelope?.state).toBe(1)
  expect(journal.events.find((event) => event.eventKind === 'batch_committed')).toMatchObject({
    sinkEvidence: 'none_required', detail: { rows: 0, writeUnits: 0 },
  })
  expect(completed).toBe(0)
})

test('prefetch continues past an empty interval while its custom loader and journal still gate checkpoint publication', async () => {
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const controller = new AbortController()
  const writing = gate()
  const releaseWrite = gate()
  const finalizing = gate()
  const releaseFinalize = gate()
  const appending = gate()
  const releaseAppend = gate()
  const appended = gate()
  const nextInterval = gate()
  const releaseNext = gate()
  const writes: number[] = []
  let advanced = false
  let completed = 0
  const append = journal.append.bind(journal)
  journal.append = async (events) => {
    const marker = events.some((event) => event.checkpoint?.state === 1)
    if (marker) {
      appending.resolve()
      await releaseAppend.promise
    }
    await append(events)
    if (marker) appended.resolve()
  }
  const stream = defineStream({
    id: 'custom-frontier', destination: destinationTable, retry: { retries: 0 },
    incremental: {
      ...cursorState({ id: 'frontier', version: 1, parse: Number }),
      complete() { completed += 1; return 99 },
    },
    async *read() {
      yield { rows: [{ id: 'one', raw: { value: 1 } }], id: 'data' }
      yield { rows: [], state: 1, id: 'completed' }
      advanced = true
      nextInterval.resolve()
      await releaseNext.promise
    },
    loader: (ctx) => {
      const delegate = simpleLoader()(ctx)
      let empty = false
      return {
        ctx,
        async write(batch) {
          empty = batch.rows.length === 0
          writes.push(batch.rows.length)
          if (empty) { writing.resolve(); await releaseWrite.promise }
          await delegate.write(batch)
        },
        async finalize() {
          if (empty) { finalizing.resolve(); await releaseFinalize.promise }
          return delegate.finalize()
        },
        abort: (reason) => delegate.abort(reason),
      }
    },
  })
  const execution = runIngestion(request(stream), { journal, destination, signal: controller.signal })
  try {
    await nextInterval.promise
    await writing.promise
    expect(writes).toEqual([1, 0])
    expect(destination.tables.get('test.frontiers')).toHaveLength(1)
    expect(advanced).toBe(true)
    expect((await journal.readCheckpoint(stream.id)).envelope).toBeUndefined()
    releaseWrite.resolve()
    await finalizing.promise
    expect((await journal.readCheckpoint(stream.id)).envelope).toBeUndefined()
    releaseFinalize.resolve()
    await appending.promise
    expect((await journal.readCheckpoint(stream.id)).envelope).toBeUndefined()
    releaseAppend.resolve()
    await appended.promise
    expect((await journal.readCheckpoint(stream.id)).envelope?.state).toBe(1)
    releaseNext.resolve()
    const result = await execution
    expect(result.streams[0]?.outcome).toBe('succeeded')
    expect(result.streams[0]?.rows).toBe(1)
    expect(result.streams[0]?.batches).toBe(3)
    expect((await journal.readCheckpoint(stream.id)).envelope?.state).toBe(99)
    expect(completed).toBe(1)
  } finally {
    controller.abort()
    for (const release of [releaseWrite, releaseFinalize, releaseAppend, releaseNext]) release.resolve()
    await execution
  }
})

test.each([false, true])('a rejected frontier append poisons ordered commits despite source prefetch (landed: %s)', async (landed) => {
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const releaseReader = gate()
  const append = journal.append.bind(journal)
  let completed = 0
  let appends = 0
  journal.append = async (events) => {
    if (events.some((event) => event.checkpoint?.state === 1)) {
      appends += 1
      if (landed) await append(events)
      throw new TypeError('frontier acknowledgement unavailable')
    }
    await append(events)
  }
  const stream = defineStream({
    id: 'ambiguous-frontier', destination: destinationTable, retry: { retries: 0 },
    incremental: {
      ...cursorState({ id: 'frontier', version: 1, parse: Number }),
      complete() { completed += 1; return 99 },
    },
    async *read() {
      yield { rows: [], state: 1, id: 'completed' }
      yield { rows: [{ id: 'must-not-be-loaded', raw: {} }], id: 'later-data' }
      await releaseReader.promise
    },
  })
  const result = await runIngestion(request(stream), {
    journal, destination, maxDurationMs: 1000,
  })
  releaseReader.resolve()
  expect(result.streams[0]?.outcome).toBe('failed')
  expect(result.streams[0]?.error).toBe('frontier acknowledgement unavailable')
  expect(result.streams[0]?.checkpointVersion).toBe(0)
  expect(result.streams[0]?.batches).toBe(0)
  expect(destination.tables.get('test.frontiers')).toBeUndefined()
  expect(completed).toBe(0)
  expect(appends).toBe(1)
  expect((await journal.readCheckpoint(stream.id)).envelope?.state).toBe(landed ? 1 : undefined)
  expect(journal.events.filter((event) => event.eventKind === 'work_finished')).toHaveLength(0)
}, 2000)

test.each(['write', 'finalize'] as const)('cancellation abandons a frontier with a held custom %s and never commits it later', async (stage) => {
  const controller = new AbortController()
  const entered = gate()
  const release = gate()
  const releaseReader = gate()
  const journal = createMemoryJournal()
  let completed = 0
  const stream = defineStream({
    id: 'cancelled-frontier', destination: destinationTable,
    incremental: {
      ...cursorState({ id: 'frontier', version: 1, parse: Number }),
      complete() { completed += 1; return 99 },
    },
    async *read() {
      yield { rows: [], state: 1, id: 'completed' }
      await releaseReader.promise
    },
    loader: (ctx) => ({
      ctx,
      async write() { if (stage === 'write') { entered.resolve(); await release.promise } },
      async finalize() {
        if (stage === 'finalize') { entered.resolve(); await release.promise }
        return { evidence: 'none_required', rows: 0, writeUnits: 0 }
      },
      async abort() {},
    }),
  })
  const execution = runIngestion(request(stream), {
    journal, destination: createMemoryDestination(), signal: controller.signal,
  })
  await entered.promise
  controller.abort(new Error('host stopped'))
  const result = await execution
  expect(result.streams[0]?.outcome).toBe('cancelled')
  expect(result.streams[0]?.checkpointVersion).toBe(0)
  expect(result.streams[0]?.batches).toBe(0)
  expect(completed).toBe(0)
  const count = journal.events.length
  release.resolve()
  releaseReader.resolve()
  await setImmediate()
  expect(journal.events).toHaveLength(count)
  expect((await journal.readCheckpoint(stream.id)).envelope).toBeUndefined()
}, 8000)

function request<T extends Record<string, unknown>, S, Q>(stream: StreamDefinition<T, S, Q>) {
  return { selected: selectStreams([definePipeline({ id: 'frontier-tests', streams: [stream] })], []), backfill: undefined }
}

function gate() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
