import { afterEach, expect, test } from 'bun:test'
import { IngestConfigError, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { lemlistPipeline } from '../index.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.LEMLIST_API_KEY
const cutoff = new Date('2000-03-01T00:00:00Z')

function setFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
  process.env.LEMLIST_API_KEY = 'fixture'
}

function selected(resource = 'activities') {
  return selectStreams([lemlistPipeline], [`resource:${resource}`]).map((item) => ({ ...item, stream: { ...item.stream, retry: { retries: 0 } } }))
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.LEMLIST_API_KEY
  else process.env.LEMLIST_API_KEY = originalToken
})

test.serial('Lemlist commits only exhausted date intervals and replays the unfinished interval with overlap', async () => {
  let fail = true
  const journal = createMemoryJournal()
  let acknowledgeInterval = () => {}
  const intervalCommitted = new Promise<void>((resolve) => { acknowledgeInterval = resolve })
  const append = journal.append
  journal.append = async (events) => {
    await append(events)
    if (events.some((event) => JSON.stringify(event.checkpoint?.state) === '{"watermark":"2000-01-31T00:00:00.000Z"}')) acknowledgeInterval()
  }
  const windows: { from: string | null; to: string | null; offset: string | null }[] = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    const from = url.searchParams.get('minDate')
    windows.push({ from, to: url.searchParams.get('maxDate'), offset: url.searchParams.get('offset') })
    if (fail && from !== '2000-01-01T00:00:00.000Z') {
      await intervalCommitted
      return new Response('denied', { status: 403 })
    }
    return Response.json([{ _id: from, custom: { retained: true } }])
  })
  const destination = createMemoryDestination()
  const request = { selected: selected(), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('lemlist.activities')).envelope?.state).toEqual({ watermark: '2000-01-31T00:00:00.000Z' })
  expect(destination.tables.get('default.lemlist_activities_raw')?.[0]?.raw).toMatchObject({ custom: { retained: true } })
  fail = false
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(windows[2]).toEqual({ from: '2000-01-30T00:00:00.000Z', to: '2000-02-29T00:00:00.000Z', offset: '0' })
  expect((await journal.readCheckpoint('lemlist.activities')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
})

test.serial('Lemlist resumes isolated explicit backfills from the completed interval frontier', async () => {
  let fail = true
  const starts: string[] = []
  setFetch(async (input) => {
    const from = new URL(String(input)).searchParams.get('minDate') ?? ''
    starts.push(from)
    if (fail && from !== '2025-01-01T00:00:00.000Z') return new Response('denied', { status: 403 })
    return Response.json([])
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selected(), backfill: { id: 'history', from: new Date('2025-01-01T00:00:00Z'), to: new Date('2025-03-01T00:00:00Z') } }
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-01') })).ok).toBe(false)
  expect((await journal.readCheckpoint('lemlist.activities#backfill:history')).envelope?.state).toEqual({ watermark: '2025-01-31T00:00:00.000Z' })
  fail = false
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-01') })).ok).toBe(true)
  expect(starts[2]).toBe('2025-01-30T00:00:00.000Z')
  expect((await journal.readCheckpoint('lemlist.activities')).envelope).toBeUndefined()
})

test.serial('Lemlist rejects a narrowed completed backfill upper bound without regressing its frontier', async () => {
  let requests = 0
  setFetch(async () => { requests++; return Response.json([]) })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const backfill = { id: 'narrowed', from: new Date('2025-01-01T00:00:00Z'), to: new Date('2025-03-01T00:00:00Z') }
  const request = { selected: selected(), backfill }
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-01') })).ok).toBe(true)
  const completedRequests = requests
  // This upper bound is still after the overlap's lower bound, but must not move the watermark backwards.
  const result = await runIngestion({ ...request, backfill: { ...backfill, to: new Date('2025-02-28T12:00:00Z') } }, {
    journal, destination, now: () => new Date('2026-01-01'),
  })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('use a new backfill ID')
  expect(requests).toBe(completedRequests)
  expect((await journal.readCheckpoint('lemlist.activities#backfill:narrowed')).envelope?.state).toEqual({ watermark: '2025-03-01T00:00:00.000Z' })
})

test.serial('Lemlist paginates a whole date interval and a rejected sink cannot advance it', async () => {
  const offsets: string[] = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    offsets.push(url.searchParams.get('offset') ?? '')
    expect(url.searchParams.get('minDate')).toBe('2000-01-01T00:00:00.000Z')
    expect(url.searchParams.get('maxDate')).toBe('2000-01-02T00:00:00.000Z')
    return Response.json(url.searchParams.get('offset') === '0' ? Array.from({ length: 100 }, (_, index) => ({ _id: String(index) })) : [{ _id: 'last' }])
  })
  const journal = createMemoryJournal()
  const request = { selected: selected(), backfill: undefined }
  const result = await runIngestion(request, { journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } }, now: () => new Date('2000-01-02') })
  expect(result.ok).toBe(false)
  expect((await journal.readCheckpoint('lemlist.activities')).envelope).toBeUndefined()
  expect(offsets).toEqual(['0', '100'])
})

test.serial('Lemlist empty activity intervals commit and campaigns always scan from zero', async () => {
  const paths: URL[] = []
  setFetch(async (input) => { paths.push(new URL(String(input))); return Response.json({ campaigns: [] }) })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selected('campaigns'), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2000-03-02') })).ok).toBe(true)
  expect(paths.map((url) => url.searchParams.get('offset'))).toEqual(['0', '0'])
  expect(paths.every((url) => url.searchParams.get('sortBy') === 'createdAt' && url.searchParams.get('sortOrder') === 'asc')).toBe(true)
  expect((await journal.readCheckpoint('lemlist.campaigns')).envelope?.state).toEqual({ completedAt: '2000-03-02T00:00:00.000Z' })
  setFetch(async () => Response.json([]))
  expect((await runIngestion({ selected: selected(), backfill: undefined }, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await journal.readCheckpoint('lemlist.activities')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
})
