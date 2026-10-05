import { expect, test } from 'bun:test'
import { runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { googleMeetConfig } from '../config.js'
import { createGoogleMeetPipeline } from '../pipeline.js'
import { parseMeetState, type Resource } from '../sources/resources.js'

const cutoff = new Date('2026-10-05T00:00:00Z')
const conference = { name: 'conferenceRecords/c1', startTime: '2026-10-02T00:00:00Z', endTime: '2026-10-04T12:00:00Z', expireTime: '2026-11-03T12:00:00Z' }
const transcript = { name: `${conference.name}/transcripts/t1`, state: 'FILE_GENERATED' }
const entry = { name: `${transcript.name}/entries/e1`, text: 'first' }
const participant = { name: `${conference.name}/participants/p1`, signedinUser: { user: 'users/u1' } }
const session = { name: `${participant.name}/participantSessions/s1`, startTime: conference.startTime }
const recording = { name: `${conference.name}/recordings/r1`, state: 'FILE_GENERATED', driveDestination: { file: 'drive-file-1' } }
const resources: readonly Resource[] = ['conferences', 'transcripts', 'transcript-entries', 'participants', 'participant-sessions', 'recordings']

test('Meet replays an unfinished discovery page and its entries under the original window', async () => {
  const urls: URL[] = []
  const pipeline = fixturePipeline((url) => { urls.push(url); return fixture(url) })
  const initial = createMemoryJournal()
  const destination = createMemoryDestination()
  const first = await runIngestion(request(pipeline, 'transcript-entries', 2), { journal: initial, destination, now: () => cutoff })
  expect(first.streams[0]?.outcome).toBe('budget_exhausted')
  const checkpoint = await initial.readCheckpoint('google-meet.transcript-entries')
  expect(checkpoint.envelope?.state).toMatchObject({ window: { from: '2026-10-04T00:00:00.000Z', to: cutoff.toISOString(), phase: 'ended' } })
  expect(checkpoint.envelope?.state).not.toHaveProperty('watermark')
  expect(checkpoint.envelope?.state).not.toHaveProperty('active')
  const previous = urls.length
  const journal = restoredJournal(initial)
  const resumed = await runIngestion(request(pipeline), { journal, destination, now: () => new Date('2026-10-06T00:00:00Z') })
  expect(resumed.ok, JSON.stringify(resumed)).toBe(true)
  expect(urls[previous]?.pathname).toBe('/v2/conferenceRecords')
  expect(urls[previous]?.searchParams.get('filter')).toBe(urls[0]?.searchParams.get('filter'))
  expect(urls[previous + 1]?.pathname).toBe(`/v2/${conference.name}/transcripts`)
  expect(urls[previous + 2]?.searchParams.has('pageToken')).toBe(false)
  expect(new Set(destination.tables.get('default.google_meet_transcript_entries_raw')?.map((row) => row.id)).size).toBe(2)
  expect((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state).toMatchObject({ watermark: cutoff.toISOString() })
})

test('Meet completes every parent on a discovery page before saving its continuation', async () => {
  const other = { ...conference, name: 'conferenceRecords/c2' }
  const urls: URL[] = []
  const pipeline = fixturePipeline((url) => {
    urls.push(url)
    if (url.pathname === '/v2/conferenceRecords') return Response.json({ conferenceRecords: url.searchParams.get('filter')?.includes('IS NULL') ? [] : [conference, other] })
    return fixture(url)
  }, { ...googleMeetConfig, pageSize: 2 })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'transcript-entries', 3), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state).toHaveProperty('window')
  const previous = urls.length
  expect((await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(urls.slice(previous).some((url) => url.pathname === `/v2/${other.name}/transcripts`)).toBe(true)
  expect(new Set(destination.tables.get('default.google_meet_transcript_entries_raw')?.map((row) => row.id)).size).toBe(4)
})

test('Meet resumes at the next discovery page after completing an earlier parent', async () => {
  const other = { ...conference, name: 'conferenceRecords/c2' }
  const urls: URL[] = []
  const pipeline = fixturePipeline((url) => {
    urls.push(url)
    if (url.pathname === '/v2/conferenceRecords') return Response.json(url.searchParams.get('filter')?.includes('IS NULL') ? { conferenceRecords: [] } : url.searchParams.has('pageToken')
      ? { conferenceRecords: [other] } : { conferenceRecords: [conference], nextPageToken: 'parents-next' })
    return fixture(url)
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'transcript-entries', 4), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state).toMatchObject({ window: { pageToken: 'parents-next' } })
  const previous = urls.length
  expect((await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(urls[previous]?.searchParams.get('pageToken')).toBe('parents-next')
  expect(urls.slice(previous).some((url) => url.pathname.startsWith(`/v2/${conference.name}/`))).toBe(false)
  expect(new Set(destination.tables.get('default.google_meet_transcript_entries_raw')?.map((row) => row.id)).size).toBe(4)
})

test('Meet replays child rows after lost destination acknowledgement without advancing discovery', async () => {
  const pipeline = fixturePipeline()
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const failed = await runIngestion(request(pipeline), { journal, destination: {
    async insert(input) {
      await destination.insert(input)
      if (input.rows.some((row) => JSON.stringify(row.raw).includes('second'))) throw new Error('lost acknowledgement')
    },
  }, now: () => cutoff })
  expect(failed.ok).toBe(false)
  expect((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state).toHaveProperty('window')
  expect((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state).not.toHaveProperty('watermark')
  expect((await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(new Set(destination.tables.get('default.google_meet_transcript_entries_raw')?.map((row) => row.id)).size).toBe(2)
})

test('Meet replay publishes changed child content under the same raw identity', async () => {
  let changed = false
  const pipeline = fixturePipeline((url) => url.pathname.endsWith('/entries') && !url.searchParams.has('pageToken')
    ? Response.json({ transcriptEntries: [{ ...entry, text: changed ? 'revised' : 'first' }], nextPageToken: 'entries-next' })
    : fixture(url))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'transcript-entries', 2), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  changed = true
  expect((await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })).ok).toBe(true)
  const versions = destination.tables.get('default.google_meet_transcript_entries_raw')?.filter((row) => row.id === JSON.stringify([googleMeetConfig.sourceId, entry.name]))
  expect(versions?.map((row) => row.raw)).toEqual([
    { ...entry, conference_name: conference.name, transcript_name: transcript.name },
    { ...entry, text: 'revised', conference_name: conference.name, transcript_name: transcript.name },
  ])
})

test('Meet discovers the preceding 24 hours by end time and also includes ongoing calls', async () => {
  const urls: URL[] = []
  const ongoing = { ...conference, name: 'conferenceRecords/ongoing', endTime: undefined }
  const pipeline = fixturePipeline((url) => {
    urls.push(url)
    return Response.json({ conferenceRecords: url.searchParams.get('filter')?.includes('IS NULL') ? [ongoing] : [conference] })
  })
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'conferences'), { journal: createMemoryJournal(), destination, now: () => cutoff })).ok).toBe(true)
  expect(urls.map((url) => url.searchParams.get('filter'))).toEqual([
    'end_time>="2026-10-04T00:00:00.000Z" AND end_time<="2026-10-05T00:00:00.000Z"',
    'end_time IS NULL AND start_time<="2026-10-05T00:00:00.000Z"',
  ])
  expect(urls.map((url) => url.searchParams.get('pageSize'))).toEqual(['1', '1'])
  expect(destination.tables.get('default.google_meet_conferences_raw')).toHaveLength(2)
})

test('Meet catches up from its completed watermark while rereading a 24-hour overlap', async () => {
  const filters: Array<string | null> = []
  const pipeline = fixturePipeline((url) => { filters.push(url.searchParams.get('filter')); return Response.json({ conferenceRecords: [] }) })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'conferences'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await runIngestion(request(pipeline, 'conferences'), { journal, destination, now: () => new Date('2026-10-07T00:00:00Z') })).ok).toBe(true)
  expect(filters[2]).toBe('end_time>="2026-10-04T00:00:00.000Z" AND end_time<="2026-10-07T00:00:00.000Z"')
})

test('Meet discovers a late transcript within the lookback without a not-ready placeholder', async () => {
  let ready = false
  const pipeline = fixturePipeline((url) => url.pathname.endsWith('/transcripts') && !ready ? Response.json({ transcripts: [] }) : fixture(url))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(destination.tables.size).toBe(0)
  ready = true
  expect((await runIngestion(request(pipeline), { journal, destination, now: () => new Date('2026-10-05T06:00:00Z') })).ok).toBe(true)
  expect(new Set(destination.tables.get('default.google_meet_transcript_entries_raw')?.map((row) => row.id)).size).toBe(2)
})

test('Meet does not retain old conference IDs after they leave discovery', async () => {
  let visible = true
  let children = 0
  const pipeline = fixturePipeline((url) => {
    if (url.pathname === '/v2/conferenceRecords' && !visible) return Response.json({ conferenceRecords: [] })
    if (url.pathname.endsWith('/transcripts')) children += 1
    return fixture(url)
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'transcripts'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  const previous = children
  visible = false
  expect((await runIngestion(request(pipeline, 'transcripts'), { journal, destination, now: () => new Date('2026-10-06T06:00:00Z') })).ok).toBe(true)
  expect(children).toBe(previous)
  expect((await journal.readCheckpoint('google-meet.transcripts')).envelope?.state).not.toHaveProperty('pending')
})

test('Meet writes changed transcript state under one identity on later completed passes', async () => {
  let ready = false
  const pipeline = fixturePipeline((url) => url.pathname.endsWith('/transcripts')
    ? Response.json({ transcripts: [{ ...transcript, state: ready ? 'FILE_GENERATED' : 'ENDED' }] })
    : fixture(url))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'transcripts'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  ready = true
  expect((await runIngestion(request(pipeline, 'transcripts'), { journal, destination, now: () => new Date('2026-10-05T01:00:00Z') })).ok).toBe(true)
  const rows = destination.tables.get('default.google_meet_transcripts_raw')
  expect(rows?.map((row) => row.id)).toEqual([JSON.stringify([googleMeetConfig.sourceId, transcript.name]), JSON.stringify([googleMeetConfig.sourceId, transcript.name])])
  expect(rows?.map((row) => row.raw)).toEqual([
    { ...transcript, state: 'ENDED', conference_name: conference.name },
    { ...transcript, conference_name: conference.name },
  ])
})

test('Meet commits empty discovery pages and resumes their token with unchanged bounds', async () => {
  const urls: URL[] = []
  const pipeline = fixturePipeline((url) => {
    urls.push(url)
    return Response.json({ conferenceRecords: [], ...(!url.searchParams.has('pageToken') && !url.searchParams.get('filter')?.includes('IS NULL') ? { nextPageToken: 'discover-next' } : {}) })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'conferences', 2), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await journal.readCheckpoint('google-meet.conferences')).envelope?.state).toMatchObject({ window: { pageToken: 'discover-next', to: cutoff.toISOString() } })
  expect((await runIngestion(request(pipeline, 'conferences'), { journal, destination, now: () => new Date('2026-10-06T00:00:00Z') })).ok).toBe(true)
  expect(urls[1]?.searchParams.get('pageToken')).toBe('discover-next')
  expect(urls[1]?.searchParams.get('filter')).toBe(urls[0]?.searchParams.get('filter'))
  expect((await journal.readCheckpoint('google-meet.conferences')).envelope?.state).toMatchObject({ watermark: cutoff.toISOString() })
  expect(destination.tables.size).toBe(0)
})

test('Meet discovery reset clears the rejected token and keeps recovery debt across fresh runs', async () => {
  const pipeline = fixturePipeline((url) => url.searchParams.has('pageToken')
    ? new Response('expired page token', { status: 400 })
    : Response.json({ conferenceRecords: [], nextPageToken: 'discover-next' }))
  const initial = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'conferences', 2), { journal: initial, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const reset = restoredJournal(initial)
  expect((await runIngestion(request(pipeline, 'conferences', 1), { journal: reset, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const state = (await reset.readCheckpoint('google-meet.conferences')).envelope?.state
  expect(state).toMatchObject({ window: { recoveryCount: 1 } })
  expect(state).not.toHaveProperty('window.pageToken')
  const replay = restoredJournal(reset)
  expect((await runIngestion(request(pipeline, 'conferences', 1), { journal: replay, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await replay.readCheckpoint('google-meet.conferences')).envelope?.state).toMatchObject({ window: { pageToken: 'discover-next', recoveryCount: 1 } })
  const fresh = restoredJournal(replay)
  const before = await fresh.readCheckpoint('google-meet.conferences')
  const stopped = await runIngestion(request(pipeline, 'conferences'), { journal: fresh, destination, now: () => cutoff })
  expect(stopped.ok).toBe(false)
  expect(stopped.streams[0]?.error).toContain('repeatedly rejected')
  expect((await fresh.readCheckpoint('google-meet.conferences')).version).toBe(before.version)
})

test('Meet can replay an expired child cursor within its unfinished parent page', async () => {
  let rejected = false
  const pipeline = fixturePipeline((url) => {
    if (url.pathname.endsWith('/entries') && url.searchParams.has('pageToken') && !rejected) {
      rejected = true
      return new Response('page token expired', { status: 400 })
    }
    return fixture(url)
  })
  const destination = createMemoryDestination()
  const result = await runIngestion(request(pipeline), { journal: createMemoryJournal(), destination, now: () => cutoff })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  expect(rejected).toBe(true)
  expect(new Set(destination.tables.get('default.google_meet_transcript_entries_raw')?.map((row) => row.id)).size).toBe(2)
})

test('Meet rejects repeated child continuations without completing the parent page', async () => {
  const pipeline = fixturePipeline((url) => url.pathname.endsWith('/entries') ? Response.json({ transcriptEntries: [entry], nextPageToken: 'same' }) : fixture(url))
  const journal = createMemoryJournal()
  const result = await runIngestion(request(pipeline), { journal, destination: createMemoryDestination(), now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('repeated')
  expect((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state).not.toHaveProperty('watermark')
})

test('Meet bounded backfills are isolated, skip ongoing calls, and reject changed bounds', async () => {
  const filters: Array<string | null> = []
  const pipeline = fixturePipeline((url) => { filters.push(url.searchParams.get('filter')); return Response.json({ conferenceRecords: [] }) })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const backfill = { id: 'october', from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-03T00:00:00Z') }
  expect((await runIngestion({ ...request(pipeline, 'conferences'), backfill }, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(filters).toEqual(['end_time>="2026-10-01T00:00:00.000Z" AND end_time<="2026-10-03T00:00:00.000Z"'])
  expect((await journal.readCheckpoint('google-meet.conferences')).version).toBe(0)
  const changed = await runIngestion({ ...request(pipeline, 'conferences'), backfill: { ...backfill, to: new Date('2026-10-04T00:00:00Z') } }, { journal, destination, now: () => cutoff })
  expect(changed.ok).toBe(false)
  expect(changed.streams[0]?.error).toContain('backfill bounds changed')
})

test('Meet factory snapshots configuration and reads tokens at request time', async () => {
  const config = { ...googleMeetConfig, sourceId: 'meet.work', streamPrefix: 'meet.work', lookbackHours: 12 }
  let token = 'first'
  const requests: Array<{ url: URL; authorization: string | null }> = []
  const pipeline = createGoogleMeetPipeline(config, {
    config: googleMeetConfig, token: () => token,
    fetch: async (input, init) => {
      const url = new URL(input)
      requests.push({ url, authorization: new Headers(init.headers).get('Authorization') })
      return fixture(url)
    },
  })
  config.sourceId = 'changed'
  config.lookbackHours = 2
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'transcripts'), { journal: createMemoryJournal(), destination, now: () => cutoff })).ok).toBe(true)
  expect(requests[0]?.url.searchParams.get('filter')).toContain('2026-10-04T12:00:00.000Z')
  expect(requests[0]?.authorization).toBe('Bearer first')
  expect(destination.tables.get('default.google_meet_transcripts_raw')?.[0]?.id).toBe(JSON.stringify(['meet.work', transcript.name]))
  token = 'second'
  expect((await runIngestion(request(pipeline, 'conferences'), { journal: createMemoryJournal(), destination, now: () => cutoff })).ok).toBe(true)
  expect(requests.at(-1)?.authorization).toBe('Bearer second')
})

test('Meet changed source settings fail instead of reinterpreting an existing checkpoint', async () => {
  const pipeline = fixturePipeline()
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'transcripts'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  const changed = fixturePipeline(fixture, { ...googleMeetConfig, lookbackHours: 12 })
  const result = await runIngestion(request(changed, 'transcripts'), { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('scope or format changed')
  const state = JSON.parse(JSON.stringify((await journal.readCheckpoint('google-meet.transcripts')).envelope?.state))
  expect(() => parseMeetState({ ...state, pending: [] }, googleMeetConfig)).toThrow('scope or format')
  expect(() => parseMeetState({ ...state, window: { from: '2026-10-05', to: '2026-10-04', phase: 'ended' } }, googleMeetConfig)).toThrow('bounds')
})

test('Meet failure in one resource leaves the other independent streams able to complete', async () => {
  const pipeline = fixturePipeline((url) => url.pathname.endsWith('/entries') ? new Response('forbidden', { status: 403 }) : fixture(url))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const result = await runIngestion(request(pipeline, 'all'), { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams.filter((stream) => stream.outcome === 'succeeded')).toHaveLength(5)
  expect(result.streams.find((stream) => stream.streamId.endsWith('.transcript-entries'))?.error).toContain('403')
  expect((await journal.readCheckpoint('google-meet.transcripts')).envelope?.state).toMatchObject({ watermark: cutoff.toISOString() })
})

for (const resource of resources) {
  test(`Meet independently reads raw ${resource}`, async () => {
    const destination = createMemoryDestination()
    const result = await runIngestion(request(fixturePipeline(), resource), { journal: createMemoryJournal(), destination, now: () => cutoff })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.streams).toHaveLength(1)
    expect(destination.tables.size).toBe(1)
    const rows = [...destination.tables.values()].flat()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => typeof row.id === 'string' && typeof row.raw === 'object')).toBe(true)
    if (resource === 'recordings') expect(rows[0]?.raw).toEqual({ ...recording, conference_name: conference.name })
    if (resource === 'participant-sessions') expect(rows[0]?.raw).toEqual({ ...session, conference_name: conference.name, participant_name: participant.name })
  })
}

test('Meet validates request-time credentials and native parent paths before publishing data', async () => {
  const missing = createGoogleMeetPipeline(googleMeetConfig, { config: googleMeetConfig, token: () => undefined, fetch: async () => { throw new Error('must not fetch') } })
  const absent = await runIngestion(request(missing), { journal: createMemoryJournal(), destination: createMemoryDestination(), now: () => cutoff })
  expect(absent.ok).toBe(false)
  expect(absent.streams[0]?.error).toContain('GOOGLE_MEET_ACCESS_TOKEN')
  const invalid = fixturePipeline((url) => url.pathname.endsWith('/transcripts') ? Response.json({ transcripts: [{ name: 'conferenceRecords/other/transcripts/t1' }] }) : fixture(url))
  const destination = createMemoryDestination()
  const result = await runIngestion(request(invalid, 'transcripts'), { journal: createMemoryJournal(), destination, now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('outside its requested parent')
  expect(destination.tables.size).toBe(0)
})

function fixturePipeline(handler: (url: URL) => Response = fixture, config = googleMeetConfig) {
  return { ...createGoogleMeetPipeline(config, { config, token: () => 'fixture',
    fetch: async (input) => handler(new URL(input)),
  }), retry: { retries: 0 } }
}

function request(pipeline: ReturnType<typeof createGoogleMeetPipeline>, resource: Resource | 'all' = 'transcript-entries', maxChunks?: number) {
  const bounded = { ...pipeline, streams: pipeline.streams.map((stream) => ({ ...stream, ...(maxChunks === undefined ? {} : { budget: { ...stream.budget, maxChunks } }) })) }
  return { selected: selectStreams([bounded], resource === 'all' ? [] : [`resource:${resource}`]), backfill: undefined }
}

function fixture(url: URL): Response {
  const path = url.pathname.slice('/v2/'.length)
  if (path === 'conferenceRecords') return Response.json({ conferenceRecords: url.searchParams.get('filter')?.includes('IS NULL') ? [] : [conference] })
  if (path.endsWith('/transcripts')) return Response.json({ transcripts: [{ ...transcript, name: `${path}/t1` }] })
  if (path.endsWith('/participants')) return Response.json({ participants: [{ ...participant, name: `${path}/p1` }] })
  if (path.endsWith('/participantSessions')) return Response.json({ participantSessions: [{ ...session, name: `${path}/s1` }] })
  if (path.endsWith('/recordings')) return Response.json({ recordings: [{ ...recording, name: `${path}/r1` }] })
  if (path.endsWith('/entries')) return Response.json(url.searchParams.has('pageToken')
    ? { transcriptEntries: [{ name: `${path}/e2`, text: 'second' }] }
    : { transcriptEntries: [{ name: `${path}/e1`, text: 'first' }], nextPageToken: 'entries-next' })
  throw new Error(`Unexpected Meet request ${url.toString()}`)
}

function restoredJournal(previous: ReturnType<typeof createMemoryJournal>) {
  const journal = createMemoryJournal()
  journal.events.push(...previous.events.map((event) => ({ ...event, checkpoint: event.checkpoint === undefined ? undefined : JSON.parse(JSON.stringify(event.checkpoint)) })))
  return journal
}
