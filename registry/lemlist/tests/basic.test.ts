import { afterEach, expect, test } from 'bun:test'
import { IngestConfigError, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { createLemlistPipeline, lemlistPipeline } from '../index.js'
import { lemlistConfig } from '../config.js'
import { defaultLemlistClientDeps } from '../client.js'

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
  expect((await journal.readCheckpoint('lemlist.campaigns')).lastSuccessSeq).toBeGreaterThan(0)
  expect(journal.events.filter((event) => event.namespaceId === 'lemlist.campaigns' && event.eventKind === 'work_finished' && event.workState === 'succeeded')).toHaveLength(2)
  setFetch(async () => Response.json([]))
  expect((await runIngestion({ selected: selected(), backfill: undefined }, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await journal.readCheckpoint('lemlist.activities')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
})

test('Lemlist binds account configuration to independent resource streams and preserves activity progress after a campaign failure', async () => {
  const config = { ...lemlistConfig, sourceId: 'lemlist.sales', pageSize: 2, start: new Date('2026-01-01'), overlapMs: 0, intervalMs: 24 * 60 * 60 * 1000 }
  const urls: URL[] = []
  let campaignsAvailable = false
  const pipeline = createLemlistPipeline(config, {
    ...defaultLemlistClientDeps, token: () => 'sales-key',
    fetch: async (input, init) => {
      const url = new URL(input)
      urls.push(url)
      expect(init.headers).toEqual({ Authorization: `Basic ${Buffer.from(':sales-key').toString('base64')}` })
      if (url.pathname.endsWith('/campaigns')) return campaignsAvailable ? Response.json({ campaigns: [] }) : new Response('denied', { status: 403 })
      return Response.json(url.searchParams.get('offset') === '0' ? [{ _id: 'a' }, { _id: 'b' }] : [{ _id: 'c', custom: true }])
    },
  })
  config.pageSize = 100
  config.start.setUTCFullYear(2000)
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const selected = selectStreams([pipeline], []).filter((item) => ['lemlist.sales.activities', 'lemlist.sales.campaigns'].includes(item.stream.id))
    .map((item) => ({ ...item, stream: { ...item.stream, retry: { retries: 0 } } }))
  const result = await runIngestion({ selected, backfill: undefined }, { journal, destination, now: () => new Date('2026-01-02') })
  expect(result.streams.map((stream) => [stream.streamId, stream.outcome])).toEqual([
    ['lemlist.sales.activities', 'succeeded'], ['lemlist.sales.campaigns', 'failed'],
  ])
  expect((await journal.readCheckpoint('lemlist.sales.activities')).envelope?.state).toEqual({ watermark: '2026-01-02T00:00:00.000Z' })
  expect((await journal.readCheckpoint('lemlist.sales.campaigns')).lastSuccessSeq).toBe(0)
  expect(urls.filter((url) => url.pathname.endsWith('/activities')).map((url) => [url.searchParams.get('minDate'), url.searchParams.get('offset'), url.searchParams.get('limit')])).toEqual([
    ['2026-01-01T00:00:00.000Z', '0', '2'], ['2026-01-01T00:00:00.000Z', '2', '2'],
  ])
  expect(destination.tables.get('default.lemlist_activities_raw')?.map((row) => row.id)).toEqual(['a', 'b', 'c'])
  campaignsAvailable = true
  urls.length = 0
  expect((await runIngestion({ selected: selectStreams([pipeline], ['resource:campaigns']), backfill: undefined }, { journal, destination })).ok).toBe(true)
  expect(urls.map((url) => url.pathname)).toEqual(['/api/campaigns'])
  expect((await journal.readCheckpoint('lemlist.sales.campaigns')).lastSuccessSeq).toBeGreaterThan(0)
  expect((await journal.readCheckpoint('lemlist.activities')).envelope).toBeUndefined()
})

test('Lemlist rejects repeated offset payloads without recording full-scan completion', async () => {
  const offsets: string[] = []
  const pipeline = createLemlistPipeline({ ...lemlistConfig, pageSize: 1 }, {
    ...defaultLemlistClientDeps, token: () => 'fixture', fetch: async (input) => {
      offsets.push(new URL(input).searchParams.get('offset') ?? '')
      return Response.json({ campaigns: [{ _id: 'repeated' }] })
    },
  })
  const journal = createMemoryJournal()
  const result = await runIngestion({ selected: selectStreams([pipeline], ['resource:campaigns']), backfill: undefined }, { journal, destination: createMemoryDestination() })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('repeated a page')
  expect(offsets).toEqual(['0', '1'])
  expect((await journal.readCheckpoint('lemlist.campaigns')).lastSuccessSeq).toBe(0)
})

test('Lemlist full-sync campaigns publish changed observations on the next run', async () => {
  let title = 'before'
  const pipeline = createLemlistPipeline(lemlistConfig, {
    ...defaultLemlistClientDeps, token: () => 'fixture',
    fetch: async () => Response.json({ campaigns: [{ _id: 'campaign', title }] }),
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selectStreams([pipeline], ['resource:campaigns']), backfill: undefined }
  expect((await runIngestion(request, { journal, destination })).ok).toBe(true)
  title = 'after'
  expect((await runIngestion(request, { journal, destination })).ok).toBe(true)
  expect(destination.tables.get('default.lemlist_campaigns_raw')?.map((row) => row.raw)).toEqual([
    { _id: 'campaign', title: 'before' }, { _id: 'campaign', title: 'after' },
  ])
})
