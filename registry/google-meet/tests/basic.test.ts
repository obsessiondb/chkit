import { afterEach, expect, test } from 'bun:test'
import { runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { google_meetPipeline } from '../index.js'
import { googleMeetConfig } from '../config.js'
import { createGoogleMeetPipeline } from '../pipeline.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.GOOGLE_MEET_ACCESS_TOKEN
const cutoff = new Date('2026-10-20T00:00:00Z')
const conference = { name: 'conferenceRecords/c1', startTime: '2026-08-01T00:00:00Z', endTime: '2026-10-01T00:00:00Z', expireTime: '2026-10-31T00:00:00Z' }
const transcript = { name: `${conference.name}/transcripts/t1`, state: 'FILE_GENERATED' }
const entry = { name: `${transcript.name}/entries/e1`, text: 'first' }
const participant = { name: `${conference.name}/participants/p1`, signedinUser: { user: 'users/u1', displayName: 'Fixture user' }, earliestStartTime: conference.startTime }
const session = { name: `${participant.name}/participantSessions/s1`, startTime: conference.startTime }
const recording = { name: `${conference.name}/recordings/r1`, state: 'FILE_GENERATED', driveDestination: { file: 'drive-file-1', exportUri: 'https://drive.google.com/file/d/drive-file-1/view' } }
const resources = ['conferences', 'transcripts', 'transcript-entries', 'participants', 'participant-sessions', 'recordings'] as const

function setFetch(handler?: (url: URL) => Response): void {
  process.env.GOOGLE_MEET_ACCESS_TOKEN = 'fixture'
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => handler ? handler(new URL(String(input))) : fixture(new URL(String(input))), { preconnect: originalFetch.preconnect })
}

function fixture(url: URL): Response {
  if (url.pathname === '/v2/conferenceRecords') return Response.json({ conferenceRecords: url.searchParams.get('filter')?.includes('IS NULL') ? [] : [conference] })
  if (url.pathname.endsWith('/transcripts')) return Response.json({ transcripts: [transcript] })
  if (url.pathname.endsWith('/participants')) return Response.json({ participants: [participant] })
  if (url.pathname.endsWith('/participantSessions')) return Response.json({ participantSessions: [session] })
  if (url.pathname.endsWith('/recordings')) return Response.json({ recordings: [recording] })
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

test('Meet factory snapshots installation settings and runs transcript and conference streams independently', async () => {
  const config = { ...googleMeetConfig, sourceId: 'meet.work', streamPrefix: 'meet.work', lookbackDays: 5, overlapDays: 2, windowDays: 3 }
  let token = 'initial'
  const requests: Array<{ url: URL; authorization: string | null }> = []
  const pipeline = createGoogleMeetPipeline(config, {
    config: googleMeetConfig,
    token: () => token,
    fetch: async (input: string, init: RequestInit) => {
      const url = new URL(input)
      requests.push({ url, authorization: new Headers(init.headers).get('Authorization') })
      return fixture(url)
    },
  })
  config.sourceId = 'edited-after-construction'
  config.streamPrefix = 'edited-after-construction'
  config.lookbackDays = 1
  config.overlapDays = 0
  config.windowDays = 1
  expect(pipeline.id).toBe('meet.work')
  expect(pipeline.streams.map((stream) => stream.id)).toEqual(resources.map((resource) => `meet.work.${resource}`))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion({ selected: selectStreams([pipeline], ['resource:transcripts']), backfill: undefined }, { journal, destination, now: () => cutoff })).ok).toBe(true)
  const transcriptCheckpoint = await journal.readCheckpoint('meet.work.transcripts')
  expect(transcriptCheckpoint.envelope?.state).toMatchObject({ watermark: '2026-10-18T00:00:00.000Z', pending: [{ name: conference.name }] })
  const transcriptStream = pipeline.streams.find((stream) => stream.id === 'meet.work.transcripts')
  expect(transcriptStream?.incremental.parseState(transcriptCheckpoint.envelope?.state)).toMatchObject({
    scope: JSON.stringify(['meet.work', 5, 2, 3]), watermark: '2026-10-18T00:00:00.000Z',
  })
  expect((await journal.readCheckpoint('meet.work.conferences')).version).toBe(0)
  expect((await journal.readCheckpoint('meet.work.transcript-entries')).version).toBe(0)
  expect(requests.map(({ url }) => url.pathname)).toEqual(['/v2/conferenceRecords', '/v2/conferenceRecords', `/v2/${conference.name}/transcripts`])
  expect(requests[0]?.url.searchParams.get('filter')).toBe('end_time>="2026-10-15T00:00:00.000Z" AND end_time<="2026-10-18T00:00:00.000Z"')
  expect(destination.tables.get('default.google_meet_transcripts_raw')?.[0]).toMatchObject({ id: JSON.stringify(['meet.work', transcript.name]), raw: { ...transcript, conference_name: conference.name } })
  token = 'rotated'
  expect((await runIngestion({ selected: selectStreams([pipeline], ['resource:conferences']), backfill: undefined }, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await journal.readCheckpoint('meet.work.transcripts')).version).toBe(transcriptCheckpoint.version)
  expect((await journal.readCheckpoint('meet.work.conferences')).envelope?.state).toMatchObject({ watermark: '2026-10-18T00:00:00.000Z' })
  expect(requests.map(({ authorization }) => authorization)).toEqual(['Bearer initial', 'Bearer initial', 'Bearer initial', 'Bearer rotated', 'Bearer rotated'])
})

test('Meet factory rejects window scope changes before resuming a saved resource stream', async () => {
  let requests = 0
  const deps = {
    config: googleMeetConfig, token: () => 'fixture',
    fetch: async (input: string) => { requests += 1; return fixture(new URL(input)) },
  }
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const pipeline = createGoogleMeetPipeline(googleMeetConfig, deps)
  expect((await runIngestion({ selected: selectStreams([pipeline], ['resource:transcripts']), backfill: undefined }, { journal, destination, now: () => cutoff })).ok).toBe(true)
  const previousRequests = requests
  const changed = createGoogleMeetPipeline({ ...googleMeetConfig, overlapDays: 1 }, deps)
  const result = await runIngestion({ selected: selectStreams([changed], ['resource:transcripts']), backfill: undefined }, { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('scope changed')
  expect(requests).toBe(previousRequests)
})

test('Meet exposes exactly six independently selectable resource streams and raw destinations', async () => {
  const expected = new Map<string, { name: string; [key: string]: unknown }>([
    ['conferences', conference], ['transcripts', { ...transcript, conference_name: conference.name }],
    ['transcript-entries', { ...entry, conference_name: conference.name, transcript_name: transcript.name }],
    ['participants', { ...participant, conference_name: conference.name }],
    ['participant-sessions', { ...session, conference_name: conference.name, participant_name: participant.name }],
    ['recordings', { ...recording, conference_name: conference.name }],
  ])
  for (const resource of resources) {
    const requests: URL[] = []
    const pipeline = fixturePipeline((url) => { requests.push(url); return fixture(url) })
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const result = await runIngestion(selectedRequest(pipeline, resource), { journal, destination, now: () => cutoff })
    expect(result.ok).toBe(true)
    expect(result.streams.map((stream) => stream.streamId)).toEqual([`google-meet.${resource}`])
    expect(destination.tables.size).toBe(1)
    const rows = destination.tables.get(`default.google_meet_${resource.replaceAll('-', '_')}_raw`)
    expect(rows?.[0]).toMatchObject({ id: JSON.stringify([googleMeetConfig.sourceId, expected.get(resource)?.name]), raw: expected.get(resource) })
    expect(requests.filter((url) => url.pathname === '/v2/conferenceRecords')).toHaveLength(2)
    expect(requests.every((url) => url.origin === 'https://meet.googleapis.com')).toBe(true)
    for (const other of resources) expect((await journal.readCheckpoint(`google-meet.${other}`)).version > 0).toBe(other === resource)
  }
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const result = await runIngestion({ selected: selectStreams([fixturePipeline(fixture)], ['provider:google-meet']), backfill: undefined }, { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(true)
  expect(result.streams).toHaveLength(6)
  expect(destination.tables.size).toBe(6)
})

for (const resource of ['participants', 'participant-sessions', 'recordings'] as const) {
  test(`Meet revisits retained conferences for late ${resource} changes without parent updates`, async () => {
    let late = false
    const pipeline = fixturePipeline((url) => {
      if (late && url.pathname === '/v2/conferenceRecords') return Response.json({ conferenceRecords: [] })
      if (resource === 'participants' && url.pathname.endsWith('/participants')) return Response.json({ participants: [{ ...participant, ...(late ? { latestEndTime: conference.endTime } : {}) }] })
      if (resource === 'participant-sessions' && url.pathname.endsWith('/participantSessions')) return Response.json({ participantSessions: [{ ...session, ...(late ? { endTime: conference.endTime } : {}) }] })
      if (resource === 'recordings' && url.pathname.endsWith('/recordings')) return Response.json({ recordings: late ? [recording] : [{ name: recording.name, state: 'ENDED' }] })
      return fixture(url)
    })
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    expect((await runIngestion(selectedRequest(pipeline, resource), { journal, destination, now: () => cutoff })).ok).toBe(true)
    late = true
    expect((await runIngestion(selectedRequest(pipeline, resource), { journal, destination, now: () => new Date('2026-10-28T00:00:00Z') })).ok).toBe(true)
    const rows = destination.tables.get(`default.google_meet_${resource.replaceAll('-', '_')}_raw`)
    expect(rows).toHaveLength(2)
    expect(rows?.[0]?.id).toBe(rows?.[1]?.id)
    expect(rows?.[1]?.raw).toMatchObject(resource === 'participants'
      ? { latestEndTime: conference.endTime }
      : resource === 'participant-sessions' ? { endTime: conference.endTime } : recording)
    expect((await journal.readCheckpoint(`google-meet.${resource}`)).envelope?.state).toMatchObject({ pending: [{ name: conference.name, checkedAt: '2026-10-28T00:00:00.000Z' }] })
  })
}

test('Meet resumes nested participant sessions and pages every participant independently', async () => {
  const secondParticipant = { name: `${conference.name}/participants/p2`, anonymousUser: { displayName: 'Guest' } }
  const secondSession = { ...session, name: `${participant.name}/participantSessions/s2` }
  const guestSession = { ...session, name: `${secondParticipant.name}/participantSessions/s3` }
  const requests: URL[] = []
  const pipeline = fixturePipeline((url) => {
    requests.push(url)
    if (url.pathname.endsWith('/participants')) return Response.json(url.searchParams.has('pageToken')
      ? { participants: [secondParticipant] } : { participants: [participant], nextPageToken: 'participants-next' })
    if (url.pathname === `/v2/${participant.name}/participantSessions`) return Response.json(url.searchParams.has('pageToken')
      ? { participantSessions: [secondSession] } : { participantSessions: [session], nextPageToken: 'sessions-next' })
    if (url.pathname === `/v2/${secondParticipant.name}/participantSessions`) return Response.json({ participantSessions: [guestSession] })
    return fixture(url)
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(selectedRequest(pipeline, 'participant-sessions', 5), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await journal.readCheckpoint('google-meet.participant-sessions')).envelope?.state).toMatchObject({ active: { collection: { items: [{ name: participant.name }], sessionPageToken: 'sessions-next', nextPageToken: 'participants-next' } }, cycle: { to: cutoff.toISOString() } })
  const requestCount = requests.length
  const resumed = restoredJournal(journal)
  expect((await runIngestion(selectedRequest(pipeline, 'participant-sessions'), { journal: resumed, destination, now: () => new Date('2026-10-21T00:00:00Z') })).ok).toBe(true)
  expect(requests[requestCount]?.pathname).toBe(`/v2/${participant.name}/participantSessions`)
  expect(requests[requestCount]?.searchParams.get('pageToken')).toBe('sessions-next')
  expect(requests.slice(requestCount).some((url) => url.pathname === '/v2/conferenceRecords')).toBe(false)
  expect(destination.tables.get('default.google_meet_participant_sessions_raw')?.map((row) => row.id)).toEqual([session, secondSession, guestSession].map((item) => JSON.stringify([googleMeetConfig.sourceId, item.name])))
  expect((await resumed.readCheckpoint('google-meet.participant-sessions')).envelope?.state).toMatchObject({ watermark: cutoff.toISOString() })
})

test('Meet recording source failure preserves acknowledged page progress and other resource checkpoints', async () => {
  let unavailable = true
  const second = { ...recording, name: `${conference.name}/recordings/r2` }
  const pipeline = fixturePipeline((url) => {
    if (url.pathname.endsWith('/recordings')) return url.searchParams.has('pageToken')
      ? unavailable ? new Response('fixture unavailable', { status: 503 }) : Response.json({ recordings: [second] })
      : Response.json({ recordings: [recording], nextPageToken: 'recordings-next' })
    return fixture(url)
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(selectedRequest(pipeline, 'participants'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  const independent = await journal.readCheckpoint('google-meet.participants')
  expect((await runIngestion(selectedRequest(pipeline, 'recordings', 4), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await runIngestion(selectedRequest(pipeline, 'recordings'), { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('google-meet.recordings')).envelope?.state).toMatchObject({ active: { collection: { pageToken: 'recordings-next' } } })
  unavailable = false
  expect((await runIngestion(selectedRequest(pipeline, 'recordings'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(destination.tables.get('default.google_meet_recordings_raw')).toHaveLength(2)
  expect((await journal.readCheckpoint('google-meet.participants')).version).toBe(independent.version)
})

test('Meet participant terminal progress waits for destination acknowledgement and replays changed content', async () => {
  let ended = false
  const pipeline = fixturePipeline((url) => url.pathname.endsWith('/participants')
    ? Response.json({ participants: [{ ...participant, ...(ended ? { latestEndTime: conference.endTime } : {}) }] }) : fixture(url))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const result = await runIngestion(selectedRequest(pipeline, 'participants'), { journal, destination: {
    insert: async (input) => { await destination.insert(input); throw new Error('fixture lost acknowledgement') },
  }, now: () => cutoff })
  expect(result.ok).toBe(false)
  const checkpoint = await journal.readCheckpoint('google-meet.participants')
  expect(checkpoint.envelope?.state).toMatchObject({ cycle: { phase: 'parents', parentIndex: 0 }, pending: [{ name: conference.name }] })
  expect(checkpoint.envelope?.state).not.toHaveProperty('watermark')
  ended = true
  expect((await runIngestion(selectedRequest(pipeline, 'participants'), { journal: restoredJournal(journal), destination, now: () => cutoff })).ok).toBe(true)
  const rows = destination.tables.get('default.google_meet_participants_raw')
  expect(rows).toHaveLength(2)
  expect(rows?.[0]?.id).toBe(rows?.[1]?.id)
  expect(rows?.[1]?.raw).toMatchObject({ latestEndTime: conference.endTime })
})

for (const resource of ['participants', 'participant-sessions', 'recordings'] as const) {
  test(`Meet ${resource} reset debt survives paused replay and fails a second rejection`, async () => {
    const field = resource === 'participant-sessions' ? 'participantSessions' : resource
    const item = resource === 'participants' ? participant : resource === 'recordings' ? recording : session
    const pipeline = fixturePipeline((url) => url.pathname.endsWith(`/${field}`)
      ? url.searchParams.has('pageToken') ? new Response('expired token', { status: 400 }) : Response.json({ [field]: [item], nextPageToken: 'next' })
      : fixture(url))
    const destination = createMemoryDestination()
    const initial = createMemoryJournal()
    const chunks = resource === 'participant-sessions' ? 5 : 4
    expect((await runIngestion(selectedRequest(pipeline, resource, chunks), { journal: initial, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
    const reset = restoredJournal(initial)
    expect((await runIngestion(selectedRequest(pipeline, resource, 1), { journal: reset, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
    const replay = restoredJournal(reset)
    expect((await runIngestion(selectedRequest(pipeline, resource, 1), { journal: replay, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
    const checkpoint = await replay.readCheckpoint(`google-meet.${resource}`)
    expect(checkpoint.envelope?.state).toMatchObject({ active: { collection: resource === 'participant-sessions'
      ? { sessionRecoveryCount: 1, sessionPageToken: 'next' } : { recoveryCount: 1, pageToken: 'next' } } })
    const final = restoredJournal(replay)
    const result = await runIngestion(selectedRequest(pipeline, resource), { journal: final, destination, now: () => cutoff })
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.error).toContain('repeatedly rejected')
    expect((await final.readCheckpoint(`google-meet.${resource}`)).version).toBe(checkpoint.version)
  })
}

test('Meet rejects attendance outside its requested parent before publishing or advancing', async () => {
  const pipeline = fixturePipeline((url) => url.pathname.endsWith('/participants')
    ? Response.json({ participants: [{ ...participant, name: 'conferenceRecords/other/participants/p1' }] }) : fixture(url))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const result = await runIngestion(selectedRequest(pipeline, 'participants'), { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('outside its requested parent')
  expect(destination.tables.size).toBe(0)
  expect((await journal.readCheckpoint('google-meet.participants')).envelope?.state).not.toHaveProperty('watermark')
})

test('Meet rejects orphaned entry tokens and traversal state from another resource before resuming', async () => {
  const pipeline = fixturePipeline(fixture)
  const journal = createMemoryJournal()
  expect((await runIngestion(selectedRequest(pipeline, 'transcript-entries', 5), { journal, destination: createMemoryDestination(), now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const raw: unknown = JSON.parse(JSON.stringify((await journal.readCheckpoint('google-meet.transcript-entries')).envelope?.state))
  expect(typeof raw).toBe('object')
  const saved = pipeline.streams[2]?.incremental.parseState(raw)
  expect(saved?.active?.entryPageToken).toBe('entries-next')
  expect(saved?.active?.transcripts).toHaveLength(1)
  expect(() => pipeline.streams[2]?.incremental.parseState({ ...saved, active: { ...saved?.active, transcriptIndex: 1 } })).toThrow('no active transcript')
  expect(() => pipeline.streams[2]?.incremental.parseState({ ...saved, active: { ...saved?.active, transcripts: undefined } })).toThrow('no active transcript')
  for (const resource of ['participants', 'participant-sessions', 'recordings']) {
    const stream = pipeline.streams.find((stream) => stream.id === `google-meet.${resource}`)
    expect(() => stream?.incremental.parseState(saved)).toThrow('another resource stream')
    expect(() => stream?.incremental.parseState({ ...saved, active: { name: conference.name, transcriptIndex: 0, transcriptPageToken: 'old-token' } })).toThrow('another resource stream')
  }
  expect(() => pipeline.streams[1]?.incremental.parseState(saved)).toThrow('another resource stream')
})

function fixturePipeline(handler: (url: URL) => Response) {
  return { ...createGoogleMeetPipeline(googleMeetConfig, { config: googleMeetConfig, token: () => 'fixture', fetch: async (input) => handler(new URL(input)) }), retry: { retries: 0 } }
}

function selectedRequest(pipeline: ReturnType<typeof fixturePipeline>, resource: string, maxChunks?: number) {
  const bounded = { ...pipeline, streams: pipeline.streams.map((stream) => ({ ...stream, ...(maxChunks === undefined ? {} : { budget: { ...stream.budget, maxChunks } }) })) }
  return { selected: selectStreams([bounded], [`resource:${resource}`]), backfill: undefined }
}
