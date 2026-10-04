import { afterEach, expect, test } from 'bun:test'
import { runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { google_calendarPipeline } from '../index.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN

function setFetch(handler: (url: URL) => Response | Promise<Response>, calendar = () => 'calendar@example.com'): void {
  process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = 'fixture'
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input))
    return url.pathname.endsWith('/events') ? handler(url) : Response.json({ id: calendar() })
  }, { preconnect: originalFetch.preconnect })
}

function request(maxChunks?: number) {
  const pipeline = { ...google_calendarPipeline, retry: { retries: 0 }, streams: google_calendarPipeline.streams.map((stream) => ({ ...stream, ...(maxChunks === undefined ? {} : { budget: { maxChunks } }) })) }
  return { selected: selectStreams([pipeline], []), backfill: undefined }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN
  else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = originalToken
})

test.serial('Calendar resumes an acknowledged page and promotes only the terminal sync token', async () => {
  const urls: URL[] = []
  setFetch((url) => {
    urls.push(url)
    return Response.json(url.searchParams.has('pageToken')
      ? { items: [{ id: 'cancelled', status: 'cancelled' }], nextSyncToken: 'sync-1' }
      : { items: [{ id: 'series', recurrence: ['RRULE:FREQ=WEEKLY'] }], nextPageToken: 'next' })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const interrupted = await runIngestion(request(1), { journal, destination })
  expect(interrupted.streams[0]?.outcome).toBe('budget_exhausted')
  expect((await journal.readCheckpoint('google-calendar.events')).envelope?.state).toMatchObject({ pageToken: 'next' })
  const resumed = await runIngestion(request(), { journal, destination })
  expect(resumed.ok).toBe(true)
  expect(urls.map((url) => url.searchParams.get('pageToken'))).toEqual([null, 'next'])
  expect((await journal.readCheckpoint('google-calendar.events')).envelope?.state).toMatchObject({ syncToken: 'sync-1', calendarId: 'calendar@example.com' })
  expect(destination.tables.get('default.google_calendar_events_raw')?.map((row) => row.raw)).toEqual([
    { id: 'series', recurrence: ['RRULE:FREQ=WEEKLY'] }, { id: 'cancelled', status: 'cancelled' },
  ])
  for (const url of urls) {
    expect(url.searchParams.get('singleEvents')).toBe('false')
    expect(url.searchParams.get('showDeleted')).toBe('true')
    expect(url.searchParams.has('timeMin')).toBe(false)
    expect(url.searchParams.has('timeMax')).toBe(false)
  }
})

test.serial('Calendar keeps the input sync token across empty delta pages', async () => {
  let bootstrap = true
  const inputs: Array<string | null> = []
  setFetch((url) => {
    inputs.push(url.searchParams.get('syncToken'))
    if (bootstrap) return Response.json({ items: [], nextSyncToken: 'sync-1' })
    return Response.json(url.searchParams.has('pageToken')
      ? { items: [], nextSyncToken: 'sync-2' }
      : { items: [], nextPageToken: 'delta-next' })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(), { journal, destination })).ok).toBe(true)
  bootstrap = false
  expect((await runIngestion(request(), { journal, destination })).ok).toBe(true)
  expect(inputs).toEqual([null, 'sync-1', 'sync-1'])
  expect((await journal.readCheckpoint('google-calendar.events')).envelope?.state).toMatchObject({ syncToken: 'sync-2' })
})

test.serial('Calendar retains its page checkpoint after a lost terminal acknowledgement', async () => {
  setFetch((url) => Response.json(url.searchParams.has('pageToken')
    ? { items: [{ id: 'second' }], nextSyncToken: 'sync-1' }
    : { items: [{ id: 'first' }], nextPageToken: 'next' }))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const first = await runIngestion(request(), { journal, destination: {
    insert: async (input) => {
      await destination.insert(input)
      if (input.rows.some((row) => JSON.stringify(row.raw).includes('second'))) throw new Error('fixture acknowledgement lost')
    },
  } })
  expect(first.ok).toBe(false)
  expect(destination.tables.get('default.google_calendar_events_raw')).toHaveLength(2)
  expect((await journal.readCheckpoint('google-calendar.events')).envelope?.state).toMatchObject({ pageToken: 'next' })
  expect((await runIngestion(request(), { journal, destination })).ok).toBe(true)
  expect((await journal.readCheckpoint('google-calendar.events')).envelope?.state).toMatchObject({ syncToken: 'sync-1' })
  expect(destination.tables.get('default.google_calendar_events_raw')).toHaveLength(2)
})

test.serial('Calendar reboots an expired sync without deleting raw observations', async () => {
  let changed = false
  const inputs: Array<string | null> = []
  setFetch((url) => {
    inputs.push(url.searchParams.get('syncToken'))
    if (!changed) return Response.json({ items: [{ id: 'old' }], nextSyncToken: 'expired' })
    return url.searchParams.has('syncToken') ? new Response('expired', { status: 410 }) : Response.json({ items: [], nextSyncToken: 'fresh' })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(), { journal, destination })).ok).toBe(true)
  changed = true
  expect((await runIngestion(request(), { journal, destination })).ok).toBe(true)
  expect(inputs).toEqual([null, 'expired', null])
  expect(destination.tables.get('default.google_calendar_events_raw')).toHaveLength(1)
  expect((await journal.readCheckpoint('google-calendar.events')).envelope?.state).toMatchObject({ syncToken: 'fresh' })
})

test.serial('Calendar rejects malformed terminal pages and repeated page tokens', async () => {
  setFetch(() => Response.json({ items: [] }))
  expect((await runIngestion(request(), { journal: createMemoryJournal(), destination: createMemoryDestination() })).ok).toBe(false)
  setFetch(() => Response.json({ items: [], nextPageToken: 'same' }))
  expect((await runIngestion(request(), { journal: createMemoryJournal(), destination: createMemoryDestination() })).ok).toBe(false)
  expect(() => google_calendarPipeline.streams[0]?.incremental.parseState({ scope: 'another source' })).toThrow('scope')
})

test.serial('Calendar refuses to reuse a checkpoint after primary changes accounts', async () => {
  let calendar = 'first@example.com'
  let eventRequests = 0
  setFetch(() => { eventRequests += 1; return Response.json({ items: [], nextSyncToken: 'sync-1' }) }, () => calendar)
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(), { journal, destination })).ok).toBe(true)
  calendar = 'second@example.com'
  const result = await runIngestion(request(), { journal, destination })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('different authenticated calendar')
  expect(eventRequests).toBe(1)
})

test.serial('Calendar safely restarts a rejected page token within the same sync', async () => {
  let reject = true
  const inputs: Array<string | null> = []
  setFetch((url) => {
    inputs.push(url.searchParams.get('pageToken'))
    if (url.searchParams.has('pageToken') && reject) { reject = false; return new Response('invalid page token', { status: 400 }) }
    return Response.json(url.searchParams.has('pageToken')
      ? { items: [], nextSyncToken: 'sync-1' }
      : { items: [{ id: 'first' }], nextPageToken: 'next' })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion(request(), { journal, destination })).ok).toBe(true)
  expect(inputs).toEqual([null, 'next', null, 'next'])
  expect(new Set(destination.tables.get('default.google_calendar_events_raw')?.map((row) => row.id)).size).toBe(1)
  expect((await journal.readCheckpoint('google-calendar.events')).envelope?.state).toMatchObject({ syncToken: 'sync-1' })
})

test.serial('Calendar rejects unsupported explicit occurrence backfill bounds before requesting Google', async () => {
  let requested = false
  setFetch(() => { requested = true; return Response.json({ items: [], nextSyncToken: 'sync-1' }) })
  const result = await runIngestion({ ...request(), backfill: { id: 'dates', from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-05T00:00:00Z') } }, { journal: createMemoryJournal(), destination: createMemoryDestination() })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('does not accept date bounds')
  expect(requested).toBe(false)
})

test.serial('Calendar carries reset debt through serialized fresh runs and successful nonterminal replay', async () => {
  let rejected = 0
  setFetch((url) => {
    if (url.searchParams.has('pageToken')) { rejected += 1; return new Response('expired page token', { status: 400 }) }
    return Response.json({ items: [{ id: 'first' }], nextPageToken: 'next' })
  })
  const destination = createMemoryDestination()
  const initial = createMemoryJournal()
  expect((await runIngestion(request(1), { journal: initial, destination })).streams[0]?.outcome).toBe('budget_exhausted')
  const afterInitial = restoredJournal(initial)
  expect((await runIngestion(request(1), { journal: afterInitial, destination })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await afterInitial.readCheckpoint('google-calendar.events')).envelope?.state).toMatchObject({ recoveryCount: 1 })
  expect((await afterInitial.readCheckpoint('google-calendar.events')).envelope?.state).not.toHaveProperty('pageToken')
  const afterReset = restoredJournal(afterInitial)
  expect((await runIngestion(request(1), { journal: afterReset, destination })).streams[0]?.outcome).toBe('budget_exhausted')
  const replayCheckpoint = await afterReset.readCheckpoint('google-calendar.events')
  expect(replayCheckpoint.envelope?.state).toMatchObject({ recoveryCount: 1, pageToken: 'next' })
  const afterReplay = restoredJournal(afterReset)
  const stopped = await runIngestion(request(2), { journal: afterReplay, destination })
  expect(stopped.ok).toBe(false)
  expect(stopped.streams[0]?.error).toContain('across resumed runs')
  expect(stopped.streams[0]?.error).toContain('editable stream chunk budget')
  expect((await afterReplay.readCheckpoint('google-calendar.events')).version).toBe(replayCheckpoint.version)
  expect(rejected).toBe(2)
  expect(() => google_calendarPipeline.streams[0]?.incremental.parseState({ ...JSON.parse(JSON.stringify(replayCheckpoint.envelope?.state)), recoveryCount: 2 })).toThrow('recoveryCount')
})

function restoredJournal(previous: ReturnType<typeof createMemoryJournal>) {
  const journal = createMemoryJournal()
  journal.events.push(...previous.events.map((event) => ({ ...event, checkpoint: event.checkpoint === undefined ? undefined : JSON.parse(JSON.stringify(event.checkpoint)) })))
  return journal
}
