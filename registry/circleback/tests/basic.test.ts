import { afterEach, expect, test } from 'bun:test'
import { IngestConfigError, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { circlebackPipeline, createCirclebackPipeline } from '../index.js'
import { circlebackConfig } from '../config.js'
import { defaultCirclebackClientDeps } from '../client.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.CIRCLEBACK_API_KEY

function setFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.CIRCLEBACK_API_KEY
  else process.env.CIRCLEBACK_API_KEY = originalToken
})

test.serial('Circleback follows the Link cursor and joins available transcripts', async () => {
  process.env.CIRCLEBACK_API_KEY = 'fixture'
  const paths: string[] = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    paths.push(url.pathname + url.search)
    if (url.pathname.endsWith('/transcript')) return url.pathname.includes('/b/') ? new Response('', { status: 404 }) : Response.json([{ text: 'Hello' }])
    if (url.searchParams.has('cursor')) return Response.json([{ id: 'b', name: 'Second' }])
    return Response.json([{ id: 'a', name: 'First' }], { headers: { Link: '</api/meetings?cursor=next>; rel="next"' } })
  })
  const destination = createMemoryDestination()
  const result = await runIngestion({ selected: selectStreams([circlebackPipeline], []), backfill: undefined }, { journal: createMemoryJournal(), destination })
  expect(result.ok).toBe(true)
  expect(paths).toEqual(['/api/meetings?ownership=All', '/api/meeting/a/transcript', '/api/meetings?cursor=next', '/api/meeting/b/transcript'])
  const rows = destination.tables.get('default.circleback_meetings_raw') ?? []
  expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
  expect(rows[0]?.raw).toMatchObject({ transcript: [{ text: 'Hello' }] })
  expect(rows[1]?.raw).toMatchObject({ transcript: null })
})

test.serial('Circleback retains unavailable transcripts and retries them when metadata has not changed', async () => {
  process.env.CIRCLEBACK_API_KEY = 'fixture'
  let available = false
  const listingStarts: string[] = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/transcript')) {
      if (available) return Response.json([{ text: 'ready' }])
      return new Response('unavailable', { status: url.pathname.includes('/a/') ? 403 : 404 })
    }
    listingStarts.push(url.search)
    return Response.json([{ id: 'a', updatedAt: '2025-01-01' }, { id: 'b', updatedAt: '2025-01-01' }])
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selectStreams([circlebackPipeline], []), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-01') })).ok).toBe(true)
  expect((await journal.readCheckpoint('circleback.meetings')).envelope?.state).toEqual({
    scope: JSON.stringify({ sourceIdentity: 'circleback.primary', ownership: 'All' }), scan: null,
    completedAt: '2026-01-01T00:00:00.000Z', unavailableTranscripts: [
      { id: 'a', status: 'forbidden', checkedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', status: 'not_found', checkedAt: '2026-01-01T00:00:00.000Z' },
    ],
  })
  available = true
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-02') })).ok).toBe(true)
  expect((await journal.readCheckpoint('circleback.meetings')).envelope?.state).toMatchObject({ completedAt: '2026-01-02T00:00:00.000Z', scan: null, unavailableTranscripts: [] })
  expect(listingStarts).toEqual(['?ownership=All', '?ownership=All'])
  expect(destination.tables.get('default.circleback_meetings_raw')?.at(-1)?.raw).toMatchObject({ transcript: [{ text: 'ready' }], _chkit_transcript_status: 'available' })
})

test.serial('Circleback sink failures do not commit enrichment state', async () => {
  process.env.CIRCLEBACK_API_KEY = 'fixture'
  setFetch(async (input) => String(input).endsWith('/transcript') ? new Response('unavailable', { status: 404 }) : Response.json([{ id: 'a' }]))
  const journal = createMemoryJournal()
  const selected = selectStreams([circlebackPipeline], []).map((item) => ({ ...item, stream: { ...item.stream, retry: { retries: 0 } } }))
  const result = await runIngestion({ selected, backfill: undefined }, {
    journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } },
  })
  expect(result.ok).toBe(false)
  expect((await journal.readCheckpoint('circleback.meetings')).envelope).toBeUndefined()
})

test.serial('Circleback fails incomplete pagination without committing scan completion and restarts from the first page', async () => {
  process.env.CIRCLEBACK_API_KEY = 'fixture'
  let fail = true
  const starts: string[] = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/transcript')) return new Response('unavailable', { status: 404 })
    if (url.searchParams.has('cursor')) return fail ? new Response('denied', { status: 403 }) : Response.json([])
    starts.push(url.search)
    return Response.json([{ id: 'a' }], { headers: { Link: '</api/meetings?cursor=next>; rel="next"' } })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const selected = selectStreams([circlebackPipeline], []).map((item) => ({ ...item, stream: { ...item.stream, retry: { retries: 0 } } }))
  const request = { selected, backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-01') })).ok).toBe(false)
  expect((await journal.readCheckpoint('circleback.meetings')).envelope?.state).toMatchObject({ completedAt: null, unavailableTranscripts: [{ id: 'a' }] })
  fail = false
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-02') })).ok).toBe(true)
  expect(starts).toEqual(['?ownership=All', '?ownership=All'])
  expect((await journal.readCheckpoint('circleback.meetings')).envelope?.state).toMatchObject({ completedAt: '2026-01-02T00:00:00.000Z' })
})

test.serial('Circleback replays unfinished enrichment while skipping acknowledged parents until the next full cycle', async () => {
  process.env.CIRCLEBACK_API_KEY = 'fixture'
  let failSecond = true
  const transcripts: string[] = []
  const journal = createMemoryJournal()
  let acknowledgeFirst = () => {}
  const firstCommitted = new Promise<void>((resolve) => { acknowledgeFirst = resolve })
  const append = journal.append
  journal.append = async (events) => {
    await append(events)
    if (events.some((event) => JSON.stringify(event.checkpoint?.state)?.includes('"completedMeetingIds":["a"]'))) acknowledgeFirst()
  }
  setFetch(async (input) => {
    const url = new URL(String(input))
    if (!url.pathname.endsWith('/transcript')) return Response.json([{ id: 'a', custom: 'first' }, { id: 'b', custom: 'second' }])
    const id = url.pathname.includes('/a/') ? 'a' : 'b'
    transcripts.push(id)
    if (id === 'b' && failSecond) {
      await firstCommitted
      return new Response('temporarily unavailable', { status: 500 })
    }
    return Response.json([{ text: id }])
  })
  const destination = createMemoryDestination()
  const selected = selectStreams([circlebackPipeline], []).map((item) => ({ ...item, stream: { ...item.stream, retry: { retries: 0 } } }))
  const request = { selected, backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-01') })).ok).toBe(false)
  expect((await journal.readCheckpoint('circleback.meetings')).envelope?.state).toMatchObject({
    completedAt: null, scan: { startedAt: '2026-01-01T00:00:00.000Z', completedMeetingIds: ['a'] },
  })
  failSecond = false
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-02') })).ok).toBe(true)
  expect(transcripts).toEqual(['a', 'b', 'b'])
  expect((await journal.readCheckpoint('circleback.meetings')).envelope?.state).toMatchObject({ completedAt: '2026-01-02T00:00:00.000Z', scan: null })
  expect(destination.tables.get('default.circleback_meetings_raw')?.map((row) => row.id)).toEqual(['a', 'b'])
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
  expect(transcripts).toEqual(['a', 'b', 'b', 'a', 'b'])
})

test.serial('Circleback empty scans complete and retain absent unavailable IDs as diagnostics', async () => {
  process.env.CIRCLEBACK_API_KEY = 'fixture'
  let listed = true
  const transcripts: string[] = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/transcript')) {
      transcripts.push(url.pathname)
      return new Response('not found', { status: 404 })
    }
    return Response.json(listed ? [{ id: 'a' }] : [])
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selectStreams([circlebackPipeline], []), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-01') })).ok).toBe(true)
  listed = false
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-02') })).ok).toBe(true)
  expect(transcripts).toHaveLength(1)
  expect((await journal.readCheckpoint('circleback.meetings')).envelope?.state).toMatchObject({
    completedAt: '2026-01-02T00:00:00.000Z', scan: null,
    unavailableTranscripts: [{ id: 'a', status: 'not_found', checkedAt: '2026-01-01T00:00:00.000Z' }],
  })
})

test('Circleback rejects changed source scopes and unbounded or duplicated recovery IDs', () => {
  const parse = circlebackPipeline.streams[0]?.incremental.parseState
  expect(parse).toBeDefined()
  const state = { scope: JSON.stringify({ sourceIdentity: 'circleback.primary', ownership: 'All' }), completedAt: null, scan: null, unavailableTranscripts: [] }
  expect(() => parse?.({ ...state, scope: 'different-source' })).toThrow('scope changed')
  expect(() => parse?.({ ...state, scan: { startedAt: '2026-01-01T00:00:00Z', completedMeetingIds: ['a', 'a'] } })).toThrow('checkpoint is invalid')
  expect(() => parse?.({ ...state, scan: { startedAt: '2026-01-01T00:00:00Z', completedMeetingIds: Array.from({ length: 10_001 }, (_, index) => String(index)) } })).toThrow('checkpoint is invalid')
})

test('Circleback binds source scope and bounds to its meeting collection without creating streams per meeting', async () => {
  const config = { ...circlebackConfig, sourceId: 'circleback.team', sourceIdentity: 'team', maxRetainedMeetings: 2 }
  const calls: string[] = []
  const pipeline = createCirclebackPipeline(config, {
    ...defaultCirclebackClientDeps, token: () => 'team-key',
    fetch: async (url, init) => {
      calls.push(url)
      expect(init.headers).toEqual({ Authorization: 'Bearer team-key', Accept: 'application/json' })
      return url.endsWith('/transcript') ? new Response('unavailable', { status: 404 }) : Response.json([{ id: 'a' }, { id: 'b' }])
    },
  })
  config.sourceIdentity = 'changed-after-construction'
  config.maxRetainedMeetings = 1
  expect(selectStreams([pipeline], ['resource:meetings']).map((item) => item.stream.id)).toEqual(['circleback.team.meetings'])
  const journal = createMemoryJournal()
  const result = await runIngestion({ selected: selectStreams([pipeline], ['resource:meetings']), backfill: undefined }, { journal, destination: createMemoryDestination() })
  expect(result.ok).toBe(true)
  expect(calls).toEqual(['https://circleback.ai/api/meetings?ownership=All', 'https://circleback.ai/api/meeting/a/transcript', 'https://circleback.ai/api/meeting/b/transcript'])
  const state = (await journal.readCheckpoint('circleback.team.meetings')).envelope?.state
  expect(state).toMatchObject({ scope: JSON.stringify({ sourceIdentity: 'team', ownership: 'All' }), scan: null })
  expect((await journal.readCheckpoint('circleback.meetings')).envelope).toBeUndefined()
  const changedScope = createCirclebackPipeline({ ...circlebackConfig, sourceIdentity: 'another-account' })
  expect(() => changedScope.streams[0]?.incremental.parseState(state)).toThrow('scope changed')
})

test('Circleback rejects cyclic Link pagination and unexpected origins without completing the cycle', async () => {
  for (const next of ['/api/meetings?cursor=repeat', 'https://untrusted.example/meetings']) {
    const calls: string[] = []
    const pipeline = createCirclebackPipeline(circlebackConfig, {
      ...defaultCirclebackClientDeps, token: () => 'fixture', fetch: async (url) => {
        calls.push(url)
        return Response.json([], { headers: { Link: `<${next}>; rel="next"` } })
      },
    })
    const journal = createMemoryJournal()
    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal, destination: createMemoryDestination() })
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(next.startsWith('/') ? 2 : 1)
    expect((await journal.readCheckpoint('circleback.meetings')).lastSuccessSeq).toBe(0)
    expect((await journal.readCheckpoint('circleback.meetings')).envelope).toBeUndefined()
  }
})
