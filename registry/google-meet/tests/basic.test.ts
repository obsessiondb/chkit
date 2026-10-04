import { afterEach, expect, test } from 'bun:test'
import { runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { google_meetPipeline } from '../index.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.GOOGLE_MEET_ACCESS_TOKEN
const cutoff = new Date('2026-10-20T00:00:00Z')
const conference = { name: 'conferenceRecords/c1', startTime: '2026-08-01T00:00:00Z', endTime: '2026-10-01T00:00:00Z', expireTime: '2026-10-31T00:00:00Z' }
const transcript = { name: `${conference.name}/transcripts/t1`, state: 'FILE_GENERATED' }
const entry = { name: `${transcript.name}/entries/e1`, text: 'first' }

function setFetch(handler?: (url: URL) => Response): void {
  process.env.GOOGLE_MEET_ACCESS_TOKEN = 'fixture'
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => handler ? handler(new URL(String(input))) : fixture(new URL(String(input))), { preconnect: originalFetch.preconnect })
}

function fixture(url: URL): Response {
  if (url.pathname === '/v2/conferenceRecords') return Response.json({ conferenceRecords: url.searchParams.get('filter')?.includes('IS NULL') ? [] : [conference] })
  if (url.pathname.endsWith('/transcripts')) return Response.json({ transcripts: [transcript] })
  if (url.pathname.endsWith('/entries')) return Response.json(url.searchParams.has('pageToken')
    ? { transcriptEntries: [{ ...entry, name: `${transcript.name}/entries/e2`, text: 'second' }] }
    : { transcriptEntries: [entry], nextPageToken: 'entries-next' })
  throw new Error(`Unexpected Meet request ${url}`)
}

function request(resource = 'transcript-entries', maxChunks?: number) {
  const pipeline = { ...google_meetPipeline, retry: { retries: 0 }, streams: google_meetPipeline.streams.map((stream) => ({ ...stream, ...(maxChunks === undefined ? {} : { budget: { ...stream.budget, maxChunks } }) })) }
  return { selected: selectStreams([pipeline], [`resource:${resource}`]), backfill: undefined }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.GOOGLE_MEET_ACCESS_TOKEN
  else process.env.GOOGLE_MEET_ACCESS_TOKEN = originalToken
})

test.serial('Meet resumes within an entry collection without losing earlier pages or changing its window', async () => {
  const urls: URL[] = []
  setFetch((url) => { urls.push(url); return fixture(url) })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const first = await runIngestion(request('transcript-entries', 5), { journal, destination, now: () => cutoff })
  expect(first.streams[0]?.outcome).toBe('budget_exhausted')
  expect((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state).toMatchObject({ active: { entryPageToken: 'entries-next' }, cycle: { to: cutoff.toISOString() } })
  const previousRequests = urls.length
  const resumed = await runIngestion(request(), { journal, destination, now: () => new Date('2026-10-21T00:00:00Z') })
  expect(resumed.ok).toBe(true)
  expect(urls.slice(previousRequests).map((url) => [url.pathname, url.searchParams.get('pageToken')])).toEqual([[`/v2/${transcript.name}/entries`, 'entries-next']])
  expect(destination.tables.get('default.google_meet_transcript_entries_raw')?.map((row) => row.raw)).toEqual([
    { ...entry, conference_name: conference.name, transcript_name: transcript.name },
    { ...entry, name: `${transcript.name}/entries/e2`, text: 'second', conference_name: conference.name, transcript_name: transcript.name },
  ])
  expect((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state).toMatchObject({ watermark: cutoff.toISOString() })
})

test.serial('Meet keeps a parent beyond discovery overlap for a late transcript', async () => {
  let late = false
  const urls: URL[] = []
  setFetch((url) => {
    urls.push(url)
    if (url.pathname === '/v2/conferenceRecords' && late) return Response.json({ conferenceRecords: [] })
    if (url.pathname.endsWith('/transcripts') && !late) return Response.json({ transcripts: [] })
    return fixture(url)
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(destination.tables.size).toBe(0)
  expect((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state).toMatchObject({ pending: [{ name: conference.name, checkedAt: cutoff.toISOString() }] })
  late = true
  expect((await runIngestion(request(), { journal, destination, now: () => new Date('2026-10-28T00:00:00Z') })).ok).toBe(true)
  expect(destination.tables.get('default.google_meet_transcript_entries_raw')).toHaveLength(2)
  const endedFilters = urls.filter((url) => url.pathname === '/v2/conferenceRecords' && !url.searchParams.get('filter')?.includes('IS NULL')).map((url) => url.searchParams.get('filter'))
  expect(endedFilters.at(-1)).toContain('2026-10-13T00:00:00.000Z')
})

test.serial('Meet queries end-time windows and ongoing calls instead of excluding long-running conferences', async () => {
  const filters: Array<string | null> = []
  setFetch((url) => { filters.push(url.searchParams.get('filter')); return fixture(url) })
  const destination = createMemoryDestination()
  expect((await runIngestion(request('conferences'), { journal: createMemoryJournal(), destination, now: () => cutoff })).ok).toBe(true)
  expect(filters).toEqual([
    'end_time>="2026-09-20T00:00:00.000Z" AND end_time<="2026-10-20T00:00:00.000Z"',
    'end_time IS NULL AND start_time<="2026-10-20T00:00:00.000Z"',
  ])
  expect(destination.tables.get('default.google_meet_conferences_raw')?.[0]?.raw).toEqual(conference)
})

test.serial('Meet replays an expired entry page token without replacing an earlier entry identity', async () => {
  let rejected = false
  setFetch((url) => {
    if (url.pathname.endsWith('/entries') && url.searchParams.has('pageToken') && !rejected) { rejected = true; return new Response('page token expired', { status: 400 }) }
    return fixture(url)
  })
  const destination = createMemoryDestination()
  const result = await runIngestion(request(), { journal: createMemoryJournal(), destination, now: () => cutoff })
  expect(result.ok).toBe(true)
  const rows = destination.tables.get('default.google_meet_transcript_entries_raw') ?? []
  expect(new Set(rows.map((row) => row.id)).size).toBe(2)
  expect(rows.some((row) => JSON.stringify(row.raw).includes('second'))).toBe(true)
})

test.serial('Meet preserves entry progress after a terminal page load failure', async () => {
  setFetch()
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const first = await runIngestion(request(), { journal, destination: {
    insert: async (input) => {
      if (input.rows.some((row) => JSON.stringify(row.raw).includes('second'))) throw new Error('fixture sink failure')
      await destination.insert(input)
    },
  }, now: () => cutoff })
  expect(first.ok).toBe(false)
  expect((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state).toMatchObject({ active: { entryPageToken: 'entries-next' } })
  expect((await runIngestion(request(), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(destination.tables.get('default.google_meet_transcript_entries_raw')).toHaveLength(2)
})

test.serial('Meet explicit backfill bounds stay isolated and constrain completed conference discovery', async () => {
  const filters: Array<string | null> = []
  setFetch((url) => { filters.push(url.searchParams.get('filter')); return Response.json({ conferenceRecords: [] }) })
  const journal = createMemoryJournal()
  const result = await runIngestion({ ...request('conferences'), backfill: { id: 'october', from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-05T00:00:00Z') } }, { journal, destination: createMemoryDestination(), now: () => cutoff })
  expect(result.ok).toBe(true)
  expect(filters).toEqual(['end_time>="2026-10-01T00:00:00.000Z" AND end_time<="2026-10-05T00:00:00.000Z"'])
  expect((await journal.readCheckpoint('google-meet.conferences')).version).toBe(0)
})

test.serial('Meet rejects malformed checkpoints and repeated page tokens', async () => {
  setFetch(() => Response.json({ conferenceRecords: [], nextPageToken: 'same' }))
  const result = await runIngestion(request('conferences'), { journal: createMemoryJournal(), destination: createMemoryDestination(), now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('repeated')
  expect(() => google_meetPipeline.streams[0]?.incremental.parseState({ scope: 'wrong', pending: [] })).toThrow('scope')
})

test.serial('Meet reports expiry during unfinished artifact work instead of silently advancing', async () => {
  setFetch()
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request('transcript-entries', 5), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const result = await runIngestion(request(), { journal, destination, now: () => new Date('2026-11-01T00:00:00Z') })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('expired during unfinished artifact work')
  expect(destination.tables.get('default.google_meet_transcript_entries_raw')).toHaveLength(1)
})

test.serial('Meet persists an empty discovery page and freezes bounds while resuming its token', async () => {
  const urls: URL[] = []
  setFetch((url) => {
    urls.push(url)
    return Response.json({ conferenceRecords: [], ...(!url.searchParams.has('pageToken') && !url.searchParams.get('filter')?.includes('IS NULL') ? { nextPageToken: 'discover-next' } : {}) })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request('conferences', 2), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await journal.readCheckpoint('google-meet.conferences')).envelope?.state).toMatchObject({ cycle: { pageToken: 'discover-next', to: cutoff.toISOString() } })
  expect((await runIngestion(request('conferences'), { journal, destination, now: () => new Date('2026-10-21T00:00:00Z') })).ok).toBe(true)
  expect(urls[1]?.searchParams.get('pageToken')).toBe('discover-next')
  expect(urls[1]?.searchParams.get('filter')).toBe(urls[0]?.searchParams.get('filter'))
  expect((await journal.readCheckpoint('google-meet.conferences')).envelope?.state).toMatchObject({ watermark: cutoff.toISOString() })
})

test.serial('Meet rejects a changed range under the same backfill checkpoint', async () => {
  setFetch(() => Response.json({ conferenceRecords: [] }))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const backfill = { id: 'stable', from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-05T00:00:00Z') }
  expect((await runIngestion({ ...request('conferences'), backfill }, { journal, destination, now: () => cutoff })).ok).toBe(true)
  const changed = await runIngestion({ ...request('conferences'), backfill: { ...backfill, to: new Date('2026-10-06T00:00:00Z') } }, { journal, destination, now: () => cutoff })
  expect(changed.ok).toBe(false)
  expect(changed.streams[0]?.error).toContain('backfill bounds changed')
})

test.serial('Meet discovery reset debt survives serialized fresh runs and an empty replay page', async () => {
  setFetch((url) => url.searchParams.has('pageToken')
    ? new Response('expired discovery token', { status: 400 })
    : Response.json({ conferenceRecords: [], nextPageToken: 'discover-next' }))
  const destination = createMemoryDestination()
  const initial = createMemoryJournal()
  expect((await runIngestion(request('conferences', 2), { journal: initial, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const afterInitial = restoredJournal(initial)
  expect((await runIngestion(request('conferences', 1), { journal: afterInitial, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await afterInitial.readCheckpoint('google-meet.conferences')).envelope?.state).toMatchObject({ cycle: { recoveryCount: 1 } })
  expect((await afterInitial.readCheckpoint('google-meet.conferences')).envelope?.state).toHaveProperty('cycle.pageToken', undefined)
  const afterReset = restoredJournal(afterInitial)
  expect((await runIngestion(request('conferences', 1), { journal: afterReset, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const checkpoint = await afterReset.readCheckpoint('google-meet.conferences')
  expect(checkpoint.envelope?.state).toMatchObject({ cycle: { recoveryCount: 1, pageToken: 'discover-next' } })
  const afterReplay = restoredJournal(afterReset)
  const stopped = await runIngestion(request('conferences'), { journal: afterReplay, destination, now: () => cutoff })
  expect(stopped.ok).toBe(false)
  expect(stopped.streams[0]?.error).toContain('discovery:ended collection repeatedly rejected')
  expect((await afterReplay.readCheckpoint('google-meet.conferences')).version).toBe(checkpoint.version)
})

test.serial('Meet transcript collection retains reset debt across fresh-run parent replay', async () => {
  setFetch((url) => {
    if (url.pathname.endsWith('/transcripts')) return url.searchParams.has('pageToken')
      ? new Response('expired transcript token', { status: 400 })
      : Response.json({ transcripts: [transcript], nextPageToken: 'transcripts-next' })
    return fixture(url)
  })
  const destination = createMemoryDestination()
  const initial = createMemoryJournal()
  expect((await runIngestion(request('transcripts', 4), { journal: initial, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const afterInitial = restoredJournal(initial)
  expect((await runIngestion(request('transcripts', 1), { journal: afterInitial, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await afterInitial.readCheckpoint('google-meet.transcripts')).envelope?.state).toMatchObject({ active: { transcriptRecoveryCount: 1 } })
  expect((await afterInitial.readCheckpoint('google-meet.transcripts')).envelope?.state).not.toHaveProperty('active.transcriptPageToken')
  const afterReset = restoredJournal(afterInitial)
  expect((await runIngestion(request('transcripts', 1), { journal: afterReset, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const checkpoint = await afterReset.readCheckpoint('google-meet.transcripts')
  expect(checkpoint.envelope?.state).toMatchObject({ active: { transcriptRecoveryCount: 1, transcriptPageToken: 'transcripts-next' } })
  const afterReplay = restoredJournal(afterReset)
  const stopped = await runIngestion(request('transcripts'), { journal: afterReplay, destination, now: () => cutoff })
  expect(stopped.ok).toBe(false)
  expect(stopped.streams[0]?.error).toContain('/transcripts collection repeatedly rejected')
  expect((await afterReplay.readCheckpoint('google-meet.transcripts')).version).toBe(checkpoint.version)
})

test.serial('Meet entry reset debt survives serialized fresh runs and a loaded nonterminal replay page', async () => {
  setFetch((url) => url.pathname.endsWith('/entries') && url.searchParams.has('pageToken')
    ? new Response('expired entry token', { status: 400 })
    : fixture(url))
  const destination = createMemoryDestination()
  const initial = createMemoryJournal()
  expect((await runIngestion(request('transcript-entries', 5), { journal: initial, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const afterInitial = restoredJournal(initial)
  expect((await runIngestion(request('transcript-entries', 1), { journal: afterInitial, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await afterInitial.readCheckpoint('google-meet.transcript-entries')).envelope?.state).toMatchObject({ active: { entryRecoveryCount: 1 } })
  expect((await afterInitial.readCheckpoint('google-meet.transcript-entries')).envelope?.state).toHaveProperty('active.entryPageToken', undefined)
  const afterReset = restoredJournal(afterInitial)
  expect((await runIngestion(request('transcript-entries', 1), { journal: afterReset, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const checkpoint = await afterReset.readCheckpoint('google-meet.transcript-entries')
  expect(checkpoint.envelope?.state).toMatchObject({ active: { entryRecoveryCount: 1, entryPageToken: 'entries-next' } })
  const afterReplay = restoredJournal(afterReset)
  const stopped = await runIngestion(request(), { journal: afterReplay, destination, now: () => cutoff })
  expect(stopped.ok).toBe(false)
  expect(stopped.streams[0]?.error).toContain('/entries collection repeatedly rejected')
  expect((await afterReplay.readCheckpoint('google-meet.transcript-entries')).version).toBe(checkpoint.version)
  expect(() => google_meetPipeline.streams[2]?.incremental.parseState({ ...JSON.parse(JSON.stringify(checkpoint.envelope?.state)), active: { ...JSON.parse(JSON.stringify(checkpoint.envelope?.state)).active, entryRecoveryCount: 2 } })).toThrow('recovery count')
})

function restoredJournal(previous: ReturnType<typeof createMemoryJournal>) {
  const journal = createMemoryJournal()
  journal.events.push(...previous.events.map((event) => ({ ...event, checkpoint: event.checkpoint === undefined ? undefined : JSON.parse(JSON.stringify(event.checkpoint)) })))
  return journal
}
