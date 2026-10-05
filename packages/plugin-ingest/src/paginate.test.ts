import { expect, expectTypeOf, test } from 'bun:test'

import { rawRows, rawTable } from './destination.js'
import { IngestConfigError } from './errors.js'
import { runIngestion } from './executor.js'
import { cursorState } from './incremental.js'
import { paginate, type Page } from './paginate.js'
import { definePipeline, defineStream, selectStreams } from './registry.js'
import { createMemoryDestination, createMemoryJournal } from './testing.js'
import type { AttemptOptions, DestinationAdapter, FetchContext } from './types.js'

interface Progress {
  syncToken: string
  pageToken?: string
}

test('yields full typed pages and unchanged metadata, including empty continuation and terminal pages', async () => {
  const controller = new AbortController()
  const attempts: AttemptOptions[] = []
  const requested: Array<string | undefined> = []
  const metadata = [
    { syncToken: 'S0', pageToken: 'P1' },
    { syncToken: 'S0', pageToken: 'P2' },
    { syncToken: 'S1' },
  ]
  const source: Page<{ id: number }, string, Progress>[] = [
    { items: [{ id: 1 }], next: 'P1', metadata: metadata[0] },
    { items: [], next: 'P2', metadata: metadata[1] },
    { items: [], next: undefined, metadata: metadata[2] },
  ]
  const context: FetchContext = {
    signal: controller.signal,
    attempt: async (operation, options = {}) => {
      attempts.push(options)
      return operation(controller.signal)
    },
  }
  const iterator = paginate({
    context, initial: 'P0', label: 'GET /changes',
    fetchPage: async (cursor, signal) => {
      requested.push(cursor)
      expect(signal).toBe(controller.signal)
      const page = source[requested.length - 1]
      if (!page) throw new Error('Unexpected page request.')
      return page
    },
  })
  expectTypeOf(iterator).toEqualTypeOf<AsyncGenerator<Page<{ id: number }, string, Progress>, void, void>>()
  const received = await Array.fromAsync(iterator)

  expect(received).toEqual(source)
  for (const [index, page] of received.entries()) {
    expect(page).toBe(source[index])
    expect(page.metadata).toBe(metadata[index])
  }
  expect(requested).toEqual(['P0', 'P1', 'P2'])
  expect(attempts).toEqual(Array.from({ length: 3 }, () => ({ label: 'GET /changes' })))
})

test('supports compound continuations without interpreting their fields', async () => {
  const requested: Array<{ offset: number; scope: string } | undefined> = []
  const received = await Array.fromAsync(paginate({
    context: fetchContext(), initial: { offset: 0, scope: 'workspace-a' },
    fetchPage: async (cursor) => {
      requested.push(cursor)
      return {
        items: [{ id: cursor?.offset }],
        next: cursor?.offset === 0 ? { scope: 'workspace-a', offset: 10 } : undefined,
      }
    },
  }))

  expect(requested).toEqual([{ offset: 0, scope: 'workspace-a' }, { offset: 10, scope: 'workspace-a' }])
  expect(received.map((page) => page.items)).toEqual([[{ id: 0 }], [{ id: 10 }]])
})

test('rejects a repeated initial compound continuation before exposing its candidate metadata', async () => {
  let requests = 0
  const iterator = paginate({
    context: fetchContext(), initial: { offset: 0, scope: 'workspace-a' },
    fetchPage: async () => {
      requests += 1
      return { items: [{ id: 1 }], next: { scope: 'workspace-a', offset: 0 }, metadata: { unsafe: true } }
    },
  })

  await expect(iterator.next()).rejects.toThrow('repeated continuation')
  expect(requests).toBe(1)
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
})

test('rejects a later cursor cycle before yielding the page that would checkpoint it', async () => {
  const iterator = paginate({
    context: fetchContext(), initial: 'A',
    fetchPage: async (cursor) => ({ items: [], next: cursor === 'A' ? 'B' : 'A', metadata: { page: cursor } }),
  })

  expect(await iterator.next()).toEqual({ done: false, value: { items: [], next: 'B', metadata: { page: 'A' } } })
  await expect(iterator.next()).rejects.toThrow('repeated continuation')
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
})

test('retains null terminal continuation tolerance and its empty page metadata', async () => {
  const iterator = paginate<number, string | null, string>({
    context: fetchContext(), fetchPage: async () => ({ items: [], next: null, metadata: 'completed' }),
  })

  expect(await Array.fromAsync(iterator)).toEqual([{ items: [], next: null, metadata: 'completed' }])
})

test.each(['before', 'during'] as const)('cancellation %s a request prevents exposing its page', async (when) => {
  const controller = new AbortController()
  let requests = 0
  if (when === 'before') controller.abort()
  const iterator = paginate({
    context: fetchContext(controller.signal),
    fetchPage: async () => {
      requests += 1
      controller.abort()
      return { items: [], next: undefined, metadata: 'uncommitted' }
    },
  })

  await expect(iterator.next()).rejects.toThrow('aborted')
  expect(requests).toBe(when === 'before' ? 0 : 1)
})

test('page metadata advances durable progress only through explicitly yielded chunk state', async () => {
  const journal = createMemoryJournal()
  const stream = defineStream({
    id: 'test.metadata', destination: rawTable({ database: 'test', name: 'metadata' }),
    async *read(context) {
      for await (const page of paginate({
        context, fetchPage: async () => ({ items: [], next: undefined, metadata: { syncToken: 'S1' } }),
      })) yield { rows: page.items }
    },
  })
  const pipeline = definePipeline({ id: 'test', streams: [stream] })
  const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, {
    journal, destination: createMemoryDestination(),
  })

  expect(result.ok).toBe(true)
  expect((await journal.readCheckpoint(stream.id)).envelope).toBeUndefined()
  expect((await journal.readCheckpoint(stream.id)).lastSuccessSeq).toBeGreaterThan(0)
})

test('cursorState resumes pages and commits an empty terminal bookmark only after covering rows succeed', async () => {
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const requested: Array<{ syncToken: string; pageToken: string | undefined }> = []
  const target = rawTable({ database: 'test', name: 'changes' })
  const pipeline = (maxChunks?: number) => definePipeline({
    id: 'test', streams: [defineStream({
      id: 'test.changes', destination: target, batchSize: 2, retry: { retries: 0 },
      budget: maxChunks === undefined ? undefined : { maxChunks },
      incremental: cursorState({ id: 'test.changes.progress', version: 1, parse: parseProgress }),
      async *read(context) {
        const syncToken = context.state?.syncToken ?? 'S0'
        for await (const page of paginate<{ id: number }, string, Progress>({
          context, initial: context.state?.pageToken,
          fetchPage: async (pageToken) => {
            requested.push({ syncToken, pageToken })
            if (syncToken === 'S1') return { items: [], next: undefined, metadata: { syncToken: 'S2' } }
            if (pageToken === 'P3') return { items: [], next: undefined, metadata: { syncToken: 'S1' } }
            const next = pageToken === undefined ? 'P2' : 'P3'
            return { items: [{ id: pageToken === undefined ? 1 : 2 }], next, metadata: { syncToken, pageToken: next } }
          },
        })) yield { rows: rawRows(page.items, (item) => String(item.id)), state: page.metadata }
      },
    })],
  })
  const run = (maxChunks?: number, sink: DestinationAdapter = destination) => runIngestion({
    selected: selectStreams([pipeline(maxChunks)], []), backfill: undefined,
  }, { journal, destination: sink })

  const paused = await run(1)
  expect(paused.streams[0]?.outcome).toBe('budget_exhausted')
  expect((await journal.readCheckpoint('test.changes')).envelope?.state).toEqual({ syncToken: 'S0', pageToken: 'P2' })
  expect(destination.tables.get('test.changes')?.map((row) => row.id)).toEqual(['1'])

  const failed = await run(undefined, { async insert() { throw new TypeError('destination write failed') } })
  expect(failed.streams[0]?.outcome).toBe('failed')
  expect(failed.streams[0]?.error).toContain('destination write failed')
  expect((await journal.readCheckpoint('test.changes')).envelope?.state).toEqual({ syncToken: 'S0', pageToken: 'P2' })

  expect((await run()).ok).toBe(true)
  expect((await journal.readCheckpoint('test.changes')).envelope?.state).toEqual({ syncToken: 'S1' })
  expect(destination.tables.get('test.changes')?.map((row) => row.id)).toEqual(['1', '2'])

  expect((await run()).ok).toBe(true)
  expect((await journal.readCheckpoint('test.changes')).envelope?.state).toEqual({ syncToken: 'S2' })
  expect(journal.events.filter((event) => event.eventKind === 'batch_committed').at(-1)?.sinkEvidence).toBe('none_required')
  expect(destination.tables.get('test.changes')?.map((row) => row.id)).toEqual(['1', '2'])
  expect(requested).toEqual([
    { syncToken: 'S0', pageToken: undefined },
    { syncToken: 'S0', pageToken: 'P2' }, { syncToken: 'S0', pageToken: 'P3' },
    { syncToken: 'S0', pageToken: 'P2' }, { syncToken: 'S0', pageToken: 'P3' },
    { syncToken: 'S1', pageToken: undefined },
  ])
})

function fetchContext(signal = new AbortController().signal): FetchContext {
  return { signal, attempt: (operation) => operation(signal) }
}

function parseProgress(raw: unknown): Progress {
  if (typeof raw !== 'object' || raw === null || !('syncToken' in raw) || typeof raw.syncToken !== 'string') {
    throw new IngestConfigError('Progress has no sync token.')
  }
  if ('pageToken' in raw && raw.pageToken !== undefined) {
    if (typeof raw.pageToken !== 'string') throw new IngestConfigError('Progress has an invalid page token.')
    return { syncToken: raw.syncToken, pageToken: raw.pageToken }
  }
  return { syncToken: raw.syncToken }
}
