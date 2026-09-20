import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { table } from '@chkit/core'

import { ingestionColumns, rawRows, rawTable } from './destination.js'
import { HttpError } from './errors.js'
import { runIngestion } from './executor.js'
import { cursorState, timestampWindow } from './incremental.js'
import { paginate } from './paginate.js'
import { definePipeline, defineStream, selectStreams } from './registry.js'
import { createMemoryDestination, createMemoryJournal } from './testing.js'
import type { DestinationAdapter } from './types.js'

const events = table({
  database: 'app',
  name: 'events',
  columns: [{ name: 'id', type: 'UInt64' }, ...ingestionColumns],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})

const pages = (count: number, size: number) =>
  Array.from({ length: count }, (_, page) => Array.from({ length: size }, (_, index) => ({ id: page * size + index })))

function httpError(status: number, headers: Record<string, string> = {}) {
  return HttpError.fromResponse(new Response('nope', { status, headers }))
}

describe('runIngestion', () => {
  test('loads rows with runtime metadata and journals progress only after sink evidence', async () => {
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const order: string[] = []
    const observed: DestinationAdapter = {
      insert: async (input) => {
        await destination.insert(input)
        order.push('insert')
      },
    }
    const stream = defineStream({
      id: 'app.events',
      destination: events,
      async *read() {
        yield { rows: [{ id: 1 }, { id: 2 }] }
      },
    })
    const pipeline = definePipeline({ id: 'app', streams: [stream] })
    const append = journal.append.bind(journal)
    journal.append = async (event) => {
      if (event.eventKind === 'batch_committed') order.push('commit')
      await append(event)
    }

    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal, destination: observed })

    expect(result.ok).toBe(true)
    expect(order).toEqual(['insert', 'commit'])
    const rows = destination.tables.get('app.events') ?? []
    expect(rows.map((row) => row.id)).toEqual([1, 2])
    expect(rows[0]?._chkit_run_id).toBe(result.runId)
    expect(typeof rows[0]?._chkit_batch_id).toBe('string')
    expect(rows[0]).not.toHaveProperty('_chkit_ingested_at')
    expect(journal.events.map((event) => event.eventKind)).toEqual([
      'run_started',
      'work_planned',
      'attempt_started',
      'batch_committed',
      'work_finished',
      'run_finished',
    ])
  })

  test('a crash before sink evidence never advances the bookmark, and the restart neither skips nor duplicates rows', async () => {
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const source = pages(3, 2)
    const stream = defineStream({
      id: 'app.cursor',
      destination: events,
      batchSize: 2,
      incremental: cursorState({
        id: 'test.page',
        version: 1,
        parse: (raw) => Number(raw),
      }),
      async *read({ selection }) {
        for (let page = selection ?? 0; page < source.length; page += 1) {
          yield { rows: source[page] ?? [], state: page + 1 }
        }
      },
    })
    const pipeline = definePipeline({ id: 'app', streams: [stream], retry: { retries: 0 } })
    let firstWrite = true
    let acknowledgementLost = false
    const crashing: DestinationAdapter = {
      insert: async (input) => {
        // A transient error on the first batch must not shift the simulated
        // acknowledgement loss onto that batch's retry.
        if (firstWrite) {
          firstWrite = false
          throw new Error('temporary insert failure')
        }
        // Second batch: the write lands but the acknowledgement is lost.
        if (input.rows[0]?.id === 2) {
          if (acknowledgementLost) throw new Error('still down')
          await destination.insert(input)
          acknowledgementLost = true
          throw new Error('socket hang up')
        }
        await destination.insert(input)
      },
    }

    const first = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal, destination: crashing })
    expect(first.ok).toBe(false)
    expect(first.streams[0]).toMatchObject({ outcome: 'failed', rows: 2, batches: 1, error: 'still down' })
    expect((await journal.readCheckpoint('app.cursor')).envelope?.state).toBe(1)

    const second = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal, destination })
    expect(second.ok).toBe(true)
    expect((await journal.readCheckpoint('app.cursor')).envelope?.state).toBe(3)
    const ids = (destination.tables.get('app.events') ?? []).map((row) => row.id)
    expect(ids).toEqual([0, 1, 2, 3, 4, 5])
  }, 10_000)

  test('timestampWindow commits the cutoff as watermark only after the whole window loaded', async () => {
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const selections: Array<{ from: string; to: string }> = []
    const stream = defineStream({
      id: 'app.window',
      destination: events,
      incremental: timestampWindow({ start: new Date('2026-01-01T00:00:00Z') }),
      async *read({ selection }) {
        selections.push({ from: selection.from.toISOString(), to: selection.to.toISOString() })
        yield { rows: [{ id: selections.length }] }
      },
    })
    const pipeline = definePipeline({ id: 'app', streams: [stream] })
    const times = [new Date('2026-02-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z')]

    for (const time of times) {
      await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal, destination, now: () => time })
    }

    expect(selections).toEqual([
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
      { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
    ])
    expect((await journal.readCheckpoint('app.window')).envelope?.state).toEqual({ watermark: '2026-03-01T00:00:00.000Z' })
  })

  test('a failed window leaves the watermark untouched', async () => {
    const journal = createMemoryJournal()
    const stream = defineStream({
      id: 'app.window',
      destination: events,
      retry: { retries: 0 },
      incremental: timestampWindow({ start: new Date(0) }),
      async *read() {
        yield { rows: [{ id: 1 }] }
        throw new Error('provider exploded')
      },
    })
    const pipeline = definePipeline({ id: 'app', streams: [stream] })

    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal, destination: createMemoryDestination() })

    expect(result.streams[0]?.outcome).toBe('failed')
    expect(result.streams[0]?.error).toContain('provider exploded')
    expect((await journal.readCheckpoint('app.window')).envelope).toBeUndefined()
  })

  test('attempt retries rate limits and transient failures but not permanent ones', async () => {
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    let calls = 0
    const flaky = defineStream({
      id: 'app.flaky',
      destination: events,
      retry: { randomize: false, minTimeout: 10 },
      async *read(context) {
        const rows = await context.attempt(async () => {
          calls += 1
          if (calls === 1) throw await httpError(429, { 'retry-after': '0.02' })
          if (calls === 2) throw await httpError(503)
          return [{ id: 1 }]
        })
        yield { rows }
      },
    })
    const denied = defineStream({
      id: 'app.denied',
      destination: events,
      async *read(context) {
        yield { rows: await context.attempt(async () => { throw await httpError(401) }) }
      },
    })
    const pipeline = definePipeline({ id: 'app', streams: [flaky, denied] })

    const result = await runIngestion(
      { selected: selectStreams([pipeline], []), backfill: undefined },
      { journal, destination }
    )

    expect(calls).toBe(3)
    // One failing stream does not stop its sibling.
    expect(result.streams.map((stream) => stream.outcome)).toEqual(['succeeded', 'failed'])
    expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled').map((event) => event.errorClass)).toEqual(['rate_limited', 'transient'])
  })

  test('refuses to reinterpret a checkpoint written by another strategy version', async () => {
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const build = (version: number) => {
      const stream = defineStream({
        id: 'app.versioned',
        destination: events,
        incremental: cursorState({ id: 'test.cursor', version, parse: (raw) => String(raw) }),
        async *read() {
          yield { rows: [{ id: 1 }], state: 'c1' }
        },
      })
      return definePipeline({ id: 'app', streams: [stream] })
    }

    await runIngestion({ selected: selectStreams([build(1)], []), backfill: undefined }, { journal, destination })
    const result = await runIngestion({ selected: selectStreams([build(2)], []), backfill: undefined }, { journal, destination })

    expect(result.streams[0]?.outcome).toBe('failed')
    expect(result.streams[0]?.error).toContain('never silently reinterprets')
  })

  test('budget exhaustion is incomplete but preserves committed progress', async () => {
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const stream = defineStream({
      id: 'app.budget',
      destination: events,
      batchSize: 1,
      budget: { maxChunks: 2 },
      incremental: cursorState({ id: 'test.page', version: 1, parse: (raw) => Number(raw) }),
      async *read({ selection }) {
        for (let page = selection ?? 0; page < 5; page += 1) yield { rows: [{ id: page }], state: page + 1 }
      },
    })
    const pipeline = definePipeline({ id: 'app', streams: [stream] })

    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal, destination })

    expect(result.ok).toBe(false)
    expect(result.streams[0]?.outcome).toBe('budget_exhausted')
    expect((await journal.readCheckpoint('app.budget')).envelope?.state).toBe(2)
  })

  test('a backfill uses an isolated checkpoint namespace', async () => {
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const stream = defineStream({
      id: 'app.window',
      destination: events,
      incremental: timestampWindow({ start: new Date(0) }),
      async *read() {
        yield { rows: [{ id: 1 }] }
      },
    })
    const pipeline = definePipeline({ id: 'app', streams: [stream] })

    await runIngestion(
      { selected: selectStreams([pipeline], []), backfill: { id: 'jan', from: new Date('2026-01-01'), to: new Date('2026-02-01') } },
      { journal, destination }
    )

    expect((await journal.readCheckpoint('app.window')).envelope).toBeUndefined()
    expect((await journal.readCheckpoint('app.window#backfill:jan')).envelope?.state).toEqual({ watermark: '2026-02-01T00:00:00.000Z' })
  })
})

describe('runtime contracts', () => {
  const run = (pipeline: ReturnType<typeof definePipeline>, env: Parameters<typeof runIngestion>[1]) =>
    runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, env)

  test.each([false, true])('new full syncs preserve changes while failed syncs reuse tokens (declared id: %s)', async (withId) => {
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    let label = 'A'
    const stream = defineStream({
      id: 'app.full', destination: events, retry: { retries: 0 },
      async *read() { yield { rows: [{ id: 1, label }], ...(withId ? { id: 'page:1' } : {}) } },
    })
    const pipeline = definePipeline({ id: 'app', streams: [stream] })
    expect((await run(pipeline, { journal, destination })).ok).toBe(true)
    const firstSuccess = (await journal.readCheckpoint(stream.id)).lastSuccessSeq
    expect(firstSuccess).toBeGreaterThan(0)

    label = 'B'
    const lossy: DestinationAdapter = { async insert(input) {
      await destination.insert(input)
      throw new Error('acknowledgement lost')
    } }
    expect((await run(pipeline, { journal, destination: lossy })).ok).toBe(false)
    expect((await journal.readCheckpoint(stream.id)).lastSuccessSeq).toBe(firstSuccess)
    expect((await run(pipeline, { journal, destination })).ok).toBe(true)

    label = 'A'
    expect((await run(pipeline, { journal, destination })).ok).toBe(true)
    expect(destination.tables.get('app.events')?.map((row) => row.label)).toEqual(['A', 'B', 'A'])
    expect((await journal.readCheckpoint(stream.id)).envelope).toBeUndefined()
  })

  test.each(['deadline', 'cancel'] as const)('a hung destination never reports success after %s', async (mode) => {
    const journal = createMemoryJournal()
    const controller = new AbortController()
    let finishWrite: () => void = () => undefined
    const destination: DestinationAdapter = { insert: () => new Promise<void>((resolve) => { finishWrite = resolve }) }
    const stream = defineStream({
      id: 'app.hung_load', destination: events,
      async *read() { yield { rows: [{ id: 1 }] } },
    })
    const timer = mode === 'cancel' ? setTimeout(() => controller.abort(), 20) : undefined
    try {
      const result = await run(definePipeline({ id: 'app', streams: [stream] }), {
        journal, destination, signal: controller.signal, maxDurationMs: mode === 'deadline' ? 20 : 60_000,
      })
      expect(result.ok).toBe(false)
      expect(result.streams[0]?.outcome).toBe(mode === 'deadline' ? 'budget_exhausted' : 'cancelled')
      expect(result.streams[0]?.rows).toBe(0)
      finishWrite()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(journal.events.filter((event) => event.eventKind === 'batch_committed')).toEqual([])
    } finally {
      clearTimeout(timer)
      finishWrite()
    }
  }, 10_000)

  test.each(['ensure', 'run_read', 'run_started', 'stream_read', 'work_planned', 'batch_committed'])(
    'the execution deadline bounds a hung journal %s', async (stage) => {
      const journal = createMemoryJournal()
      const append = journal.append.bind(journal)
      const read = journal.readCheckpoint.bind(journal)
      const hung = () => new Promise<never>(() => undefined)
      if (stage === 'ensure') journal.ensure = hung
      journal.readCheckpoint = (namespace) => (
        (stage === 'run_read' && namespace === '@run') || (stage === 'stream_read' && namespace !== '@run')
          ? hung() : read(namespace)
      )
      journal.append = (event) => event.eventKind === stage ? hung() : append(event)
      const stream = defineStream({ id: 'app.journal', destination: events, async *read() { yield { rows: [{ id: 1 }] } } })
      const execution = run(definePipeline({ id: 'app', streams: [stream] }), {
        journal, destination: createMemoryDestination(), maxDurationMs: 20,
      })
      if (['ensure', 'run_read', 'run_started'].includes(stage)) {
        await expect(execution).rejects.toThrow('execution budget exhausted')
      } else {
        const result = await execution
        expect(result.ok).toBe(false)
        expect(result.streams[0]?.outcome).toBe('budget_exhausted')
      }
    }, 1000
  )

  test.each(['work_finished', 'run_finished'])('a hung terminal journal %s has bounded cleanup', async (stage) => {
    const journal = createMemoryJournal()
    const append = journal.append.bind(journal)
    journal.append = (event) => event.eventKind === stage ? new Promise(() => undefined) : append(event)
    const stream = defineStream({ id: 'app.terminal', destination: events, async *read() { yield { rows: [{ id: 1 }] } } })
    const execution = run(definePipeline({ id: 'app', streams: [stream] }), {
      journal, destination: createMemoryDestination(), maxDurationMs: 100,
    })
    if (stage === 'run_finished') await expect(execution).rejects.toThrow()
    else expect((await execution).ok).toBe(false)
  }, 8000)

  test('a throwing loader factory releases its permit for sibling streams', async () => {
    const failed = defineStream({
      id: 'app.factory', destination: events, retry: { retries: 0 },
      loader() { throw new Error('loader construction failed') },
      async *read() { yield { rows: [{ id: 1 }] } },
    })
    const healthy = defineStream({ id: 'app.healthy', destination: events, async *read() { yield { rows: [{ id: 2 }] } } })
    const destination = createMemoryDestination()
    const result = await run(definePipeline({ id: 'app', streams: [failed, healthy], maxLoads: 1 }), {
      journal: createMemoryJournal(), destination, maxDurationMs: 100,
    })
    expect(result.streams.map((stream) => stream.outcome)).toEqual(['failed', 'succeeded'])
    expect(destination.tables.get('app.events')?.map((row) => row.id)).toEqual([2])
  })

  test('a declared interval id keeps batch identity stable when replayed rows changed', async () => {
    const build = (label: string, withId: boolean) => {
      const stream = defineStream({
        id: 'app.mutable',
        destination: events,
        async *read() {
          yield { rows: [{ id: 1, label }], ...(withId ? { id: 'page:1' } : {}) }
        },
      })
      return definePipeline({ id: 'app', streams: [stream] })
    }

    const declared = createMemoryDestination()
    await run(build('before', true), { journal: createMemoryJournal(), destination: declared })
    await run(build('after', true), { journal: createMemoryJournal(), destination: declared })
    expect(declared.tables.get('app.events')).toHaveLength(1)

    // Without a declared interval the content hash wins: a duplicate over a suppressed change.
    const undeclared = createMemoryDestination()
    await run(build('before', false), { journal: createMemoryJournal(), destination: undeclared })
    await run(build('after', false), { journal: createMemoryJournal(), destination: undeclared })
    expect(undeclared.tables.get('app.events')).toHaveLength(2)
  })

  test('the execution budget interrupts a hung reader and preserves committed progress', async () => {
    const journal = createMemoryJournal()
    const stream = defineStream({
      id: 'app.hung',
      destination: events,
      batchSize: 1,
      incremental: cursorState({ id: 'test.page', version: 1, parse: (raw) => Number(raw) }),
      async *read() {
        yield { rows: [{ id: 1 }], state: 1 }
        await new Promise(() => undefined)
      },
    })
    const pipeline = definePipeline({ id: 'app', streams: [stream] })

    const result = await run(pipeline, { journal, destination: createMemoryDestination(), maxDurationMs: 50 })

    expect(result.streams[0]?.outcome).toBe('budget_exhausted')
    expect((await journal.readCheckpoint('app.hung')).envelope?.state).toBe(1)
    expect(journal.events.at(-1)?.eventKind).toBe('run_finished')
  })

  test('an oversized chunk fails the stream instead of being buffered', async () => {
    const stream = defineStream({
      id: 'app.big',
      destination: events,
      budget: { maxChunkRows: 2 },
      async *read() {
        yield { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }
      },
    })
    const result = await run(definePipeline({ id: 'app', streams: [stream] }), { journal: createMemoryJournal(), destination: createMemoryDestination() })
    expect(result.streams[0]?.error).toContain('above the 2-row bound')
  })

  test('a mapped row cannot supply the destination-owned publication time', async () => {
    const destination = createMemoryDestination()
    const stream = defineStream({
      id: 'app.stamped',
      destination: events,
      async *read() {
        yield { rows: [{ id: 1, _chkit_ingested_at: '2000-01-01 00:00:00' }] }
      },
    })
    await run(definePipeline({ id: 'app', streams: [stream] }), { journal: createMemoryJournal(), destination })
    expect(destination.tables.get('app.events')?.[0]).not.toHaveProperty('_chkit_ingested_at')
  })

  test('an ambiguous journal append retries the same fact without consuming a sequence number', async () => {
    const journal = createMemoryJournal()
    const append = journal.append.bind(journal)
    let failures = 0
    journal.append = async (event) => {
      if (event.eventKind === 'batch_committed' && failures === 0) {
        failures += 1
        throw new Error('acknowledgement lost')
      }
      await append(event)
    }
    const stream = defineStream({ id: 'app.events', destination: events, async *read() { yield { rows: [{ id: 1 }] } } })

    const result = await run(definePipeline({ id: 'app', streams: [stream] }), { journal, destination: createMemoryDestination() })

    expect(result.ok).toBe(true)
    const sequences = journal.events.filter((event) => event.namespaceId === 'app.events').map((event) => event.eventSeq)
    expect(sequences).toEqual([1, 2, 3, 4])
  })

  test('a failing loader cleanup does not mask the write failure or stop the retry', async () => {
    const destination = createMemoryDestination()
    let writes = 0
    const stream = defineStream({
      id: 'app.cleanup',
      destination: events,
      loader: (ctx) => ({
        ctx,
        async write(batch) {
          writes += 1
          if (writes === 1) throw new Error('write failed')
          await ctx.destination.insert({ table: ctx.table, rows: batch.rows, token: batch.batchId })
        },
        finalize: async () => ({ evidence: 'clickhouse_ack', rows: 1, writeUnits: 1 }),
        abort: async () => {
          throw new Error('cleanup failed')
        },
      }),
      async *read() {
        yield { rows: [{ id: 1 }] }
      },
    })

    const result = await run(definePipeline({ id: 'app', streams: [stream] }), { journal: createMemoryJournal(), destination })

    expect(result.ok).toBe(true)
    expect(writes).toBe(2)
  })
})

describe('pipeline concurrency and retries', () => {
  const run = (pipeline: ReturnType<typeof definePipeline>, env: Parameters<typeof runIngestion>[1]) =>
    runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, env)

  test.each(['fetches', 'loads'] as const)('%s release capacity during backoff and never exceed the limit', async (mode) => {
    const order: number[] = []
    let active = 0
    let peak = 0
    const operation = async (id: number) => {
      order.push(id)
      active += 1
      peak = Math.max(peak, active)
      await sleep(5)
      active -= 1
      if (order.length === 1) throw new Error('temporary failure')
      return [{ id }]
    }
    const streams = [1, 2].map((id) => defineStream({
      id: `app.stream${id}`, destination: events,
      async *read({ attempt }) {
        yield { rows: mode === 'fetches' ? await attempt(() => operation(id)) : [{ id }] }
      },
    }))
    const destination: DestinationAdapter = {
      async insert({ rows }) { if (mode === 'loads') await operation(Number(rows[0]?.id)) },
    }
    const result = await run(definePipeline({
      id: 'app', streams, maxStreams: 2, maxFetches: 1, maxLoads: 1,
      retry: { retries: 1, minTimeout: 10, randomize: false },
    }), { journal: createMemoryJournal(), destination })

    expect(result.ok).toBe(true)
    expect(order).toEqual([1, 2, 1])
    expect(peak).toBe(1)
  })

  test('stream limits serialize readers and cancellation prevents queued readers from starting', async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController()
      const order: string[] = []
      const streams = [1, 2].map((id) => defineStream({
        id: `app.stream${id}`, destination: events,
        async *read() {
          order.push(`start:${id}`)
          if (cancel) controller.abort()
          await sleep(5)
          order.push(`end:${id}`)
          yield { rows: [] }
        },
      }))
      const result = await run(definePipeline({ id: 'app', streams, maxStreams: 1 }), {
        journal: createMemoryJournal(), destination: createMemoryDestination(), signal: controller.signal,
      })
      if (cancel) {
        expect(result.streams.map((stream) => stream.outcome)).toEqual(['cancelled', 'cancelled'])
        expect(order).not.toContain('start:2')
      } else {
        expect(result.ok).toBe(true)
        expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
      }
    }
  })

  test('reader retries resume from committed progress and exhausted source retries do not recreate the reader', async () => {
    const journal = createMemoryJournal()
    const append = journal.append.bind(journal)
    let committed: () => void = () => undefined
    const saved = new Promise<void>((resolve) => { committed = resolve })
    journal.append = async (event) => {
      await append(event)
      if (event.eventKind === 'batch_committed') committed()
    }
    const selections: Array<number | undefined> = []
    let sourceCalls = 0
    let readers = 0
    const resumable = defineStream({
      id: 'app.resumable', destination: events, batchSize: 1,
      incremental: cursorState({ id: 'page', version: 1, parse: (raw) => Number(raw) }),
      async *read({ selection }) {
        selections.push(selection)
        if (selection === undefined) {
          yield { rows: [{ id: 1 }], state: 1 }
          await saved
          throw new Error('reader disconnected')
        }
        yield { rows: [{ id: 2 }], state: 2 }
      },
    })
    const exhausted = defineStream({
      id: 'app.exhausted', destination: events,
      async *read({ attempt }) {
        readers += 1
        await attempt(async () => { sourceCalls += 1; throw new Error('source unavailable') })
      },
    })
    const result = await run(definePipeline({
      id: 'app', streams: [resumable, exhausted], retry: { retries: 1, minTimeout: 0 },
    }), { journal, destination: createMemoryDestination() })

    expect(result.streams.map((stream) => stream.outcome)).toEqual(['succeeded', 'failed'])
    expect(selections).toEqual([undefined, 1])
    expect((await journal.readCheckpoint(resumable.id)).envelope?.state).toBe(2)
    expect(readers).toBe(1)
    expect(sourceCalls).toBe(2)
  })
})

describe('rawTable', () => {
  test('lands provider objects untouched next to a stable id', async () => {
    const destination = createMemoryDestination()
    const landing = rawTable({ database: 'app_raw', name: 'tickets' })
    const ticket = { key: 'T-1', requester: { email: 'a@example.com' }, tags: [{ name: 'vip' }] }
    const stream = defineStream({
      id: 'app.tickets',
      destination: landing,
      async *read() {
        yield { rows: rawRows([ticket], (item) => item.key) }
      },
    })

    await runIngestion({ selected: selectStreams([definePipeline({ id: 'app', streams: [stream] })], []), backfill: undefined }, { journal: createMemoryJournal(), destination })

    expect(landing.columns.map((column) => `${column.name}:${column.type}`).slice(0, 2)).toEqual(['id:String', 'raw:JSON'])
    expect(destination.tables.get('app_raw.tickets')?.[0]).toMatchObject({ id: 'T-1', raw: ticket })
  })
})

describe('selectStreams', () => {
  test('repeated tags use exact AND semantics and an explicit empty selection fails', () => {
    const hourly = defineStream({ id: 'crm.people', destination: events, tags: ['schedule:1h'], async *read() {} })
    const daily = defineStream({ id: 'crm.deals', destination: events, tags: ['schedule:1d'], async *read() {} })
    const pipeline = definePipeline({ id: 'crm', tags: ['crm'], streams: [hourly, daily] })

    expect(selectStreams([pipeline], []).map((entry) => entry.stream.id)).toEqual(['crm.people', 'crm.deals'])
    expect(selectStreams([pipeline], ['crm', 'schedule:1h']).map((entry) => entry.stream.id)).toEqual(['crm.people'])
    expect(selectStreams([pipeline], ['stream:crm.deals']).map((entry) => entry.stream.id)).toEqual(['crm.deals'])
    expect(() => selectStreams([pipeline], ['schedule'])).toThrow('No stream matches every requested tag')
  })

  test('stream ids are globally unique across pipelines', () => {
    const stream = defineStream({ id: 'crm.people', destination: events, async *read() {} })
    const a = definePipeline({ id: 'a', streams: [stream] })
    const b = definePipeline({ id: 'b', streams: [stream] })
    expect(() => selectStreams([a, b], [])).toThrow('globally unique')
  })
})

describe('paginate', () => {
  test('rejects a repeated continuation instead of looping forever', async () => {
    const context = { signal: new AbortController().signal, attempt: <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(new AbortController().signal) }
    const iterate = async () => {
      for await (const _ of paginate({ context, fetchPage: async () => ({ items: [1], next: 'same' }) })) {
        // drain
      }
    }
    await expect(iterate()).rejects.toThrow('repeated continuation')
  })
})
