import { afterEach, expect, test } from 'bun:test'
import { IngestConfigError, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { createLinearPipeline, linearPipeline } from '../index.js'
import { linearConfig } from '../config.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.LINEAR_API_KEY
const cutoff = new Date('2026-01-02T00:00:00Z')
const emptyComments = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }

function setFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
  process.env.LINEAR_API_KEY = 'fixture'
}

function selected() {
  return selectStreams([linearPipeline], []).map((item) => ({ ...item, stream: { ...item.stream, batchSize: 1, retry: { retries: 0 } } }))
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.LINEAR_API_KEY
  else process.env.LINEAR_API_KEY = originalToken
})

test.serial('Linear filters bounded archived issues and completes comment and issue connections', async () => {
  const requests: { query: string; variables: Record<string, unknown> }[] = []
  setFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    if (body.query.includes('query IssueComments')) return Response.json({ data: { issue: { comments: {
      nodes: [{ id: 'c2', body: 'continued', custom: true }], pageInfo: { hasNextPage: false, endCursor: 'comments-done' },
    } } } })
    if (body.variables.after) return Response.json({ data: { issues: {
      nodes: [{ id: 'b', updatedAt: '2026-01-01T00:00:00Z', comments: emptyComments }], pageInfo: { hasNextPage: false, endCursor: 'done' },
    } } })
    return Response.json({ data: { issues: {
      nodes: [{ id: 'a', updatedAt: '2026-01-01T00:00:00Z', archivedAt: '2026-01-01T00:00:00Z', comments: {
        nodes: [{ id: 'c1', body: 'first' }], pageInfo: { hasNextPage: true, endCursor: 'comments-next' },
      } }], pageInfo: { hasNextPage: true, endCursor: 'issues-next' },
    } } })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const result = await runIngestion({ selected: selected(), backfill: undefined }, { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(true)
  expect(requests[0]?.query).toContain('includeArchived: true')
  expect(requests[0]?.query).toContain('gte: $from, lte: $to')
  expect(requests[0]?.variables).toEqual({ after: null, from: '1970-01-01T00:00:00.000Z', to: cutoff.toISOString() })
  expect(requests[1]?.variables).toEqual({ id: 'a', after: 'comments-next' })
  expect(requests[2]?.variables.after).toBe('issues-next')
  const rows = destination.tables.get('default.linear_issues_raw') ?? []
  expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
  expect(rows[0]?.raw).toMatchObject({ archivedAt: '2026-01-01T00:00:00Z', comments: { nodes: [{ id: 'c1' }, { id: 'c2', custom: true }], pageInfo: { hasNextPage: false } } })
  expect((await journal.readCheckpoint('linear.issues')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
})

test.serial('Linear comment failures leave the window uncommitted and replay from the beginning', async () => {
  let fail = true
  const starts: unknown[] = []
  setFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    if (body.query.includes('query IssueComments')) {
      return fail ? Response.json({ errors: [{ message: 'unavailable' }] }) : Response.json({ data: { issue: { comments: emptyComments } } })
    }
    starts.push(body.variables.after)
    return Response.json({ data: { issues: {
      nodes: [{ id: 'a', updatedAt: '2026-01-01T00:00:00Z', comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next' } } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selected(), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('linear.issues')).envelope).toBeUndefined()
  expect(destination.tables.size).toBe(0)
  fail = false
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(starts).toEqual([null, null])
})

test.serial('Linear destination failure does not save a timestamp watermark', async () => {
  setFetch(async () => Response.json({ data: { issues: { nodes: [{ id: 'a', updatedAt: '2026-01-01T00:00:00Z', comments: emptyComments }], pageInfo: { hasNextPage: false, endCursor: null } } } }))
  const journal = createMemoryJournal()
  const result = await runIngestion({ selected: selected(), backfill: undefined }, {
    journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } }, now: () => cutoff,
  })
  expect(result.ok).toBe(false)
  expect((await journal.readCheckpoint('linear.issues')).envelope).toBeUndefined()
})

test.serial('Linear empty windows commit and subsequent runs overlap their cutoff', async () => {
  const starts: unknown[] = []
  setFetch(async (_input, init) => {
    starts.push(JSON.parse(String(init?.body)).variables.from)
    return Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selected(), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-03T00:00:00Z') })).ok).toBe(true)
  expect(starts).toEqual(['1970-01-01T00:00:00.000Z', '2026-01-01T23:55:00.000Z'])
})

test.serial('Linear retries documented GraphQL HTTP 400 rate-limit errors', async () => {
  let attempts = 0
  setFetch(async () => {
    attempts++
    if (attempts === 1) return Response.json({ errors: [{ message: 'rate limit', extensions: { code: 'RATELIMITED' } }] }, { status: 400 })
    return Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })
  })
  const selected = selectStreams([linearPipeline], []).map((item) => ({ ...item, stream: { ...item.stream, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 } } }))
  const journal = createMemoryJournal()
  const result = await runIngestion({ selected, backfill: undefined }, { journal, destination: createMemoryDestination(), now: () => cutoff })
  expect(result.ok).toBe(true)
  expect(attempts).toBe(2)
  expect(journal.events.some((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toBe(true)
})

test.serial('Linear rejects malformed continuation cursors before requesting another page', async () => {
  for (const endCursor of [7, ' ']) {
    let requests = 0
    setFetch(async () => {
      requests++
      return Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor } } } })
    })
    const journal = createMemoryJournal()
    const result = await runIngestion({ selected: selected(), backfill: undefined }, { journal, destination: createMemoryDestination(), now: () => cutoff })
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.error).toContain('no new issue cursor')
    expect(requests).toBe(1)
    expect((await journal.readCheckpoint('linear.issues')).envelope).toBeUndefined()
  }
})

test.serial('Linear binds custom date selection and isolates installation progress', async () => {
  const requests: { query: string; variables: Record<string, unknown> }[] = []
  const config = { ...linearConfig, sourceId: 'linear.fixture', start: new Date('2025-01-01'), overlapMs: 60_000 }
  const pipeline = createLinearPipeline(config, {
    token: () => 'bound-token',
    fetch: async (_input, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('bound-token')
      requests.push(JSON.parse(String(init.body)))
      return Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })
    },
  })
  config.start.setUTCFullYear(2000)
  config.overlapMs = 60 * 60 * 1000
  const failing = createLinearPipeline({ ...linearConfig, sourceId: 'linear.denied' }, {
    token: () => 'denied-token', fetch: async () => new Response('denied', { status: 403 }),
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const selected = selectStreams([failing, pipeline], []).map((item) => ({ ...item, stream: { ...item.stream, retry: { retries: 0 } } }))
  const result = await runIngestion({ selected, backfill: undefined }, { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams.map((stream) => stream.outcome)).toEqual(['failed', 'succeeded'])
  expect(requests[0]?.variables).toEqual({ after: null, from: '2025-01-01T00:00:00.000Z', to: cutoff.toISOString() })
  expect((await journal.readCheckpoint('linear.denied.issues')).envelope).toBeUndefined()
  expect((await journal.readCheckpoint('linear.fixture.issues')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
  const onlyFixture = selectStreams([failing, pipeline], ['stream:linear.fixture.issues'])
  expect(onlyFixture.map((item) => item.stream.id)).toEqual(['linear.fixture.issues'])
  expect((await runIngestion({ selected: onlyFixture, backfill: undefined }, { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
  expect(requests[1]?.variables.from).toBe('2026-01-01T23:59:00.000Z')
  expect((await journal.readCheckpoint('linear.issues')).envelope).toBeUndefined()
})

test.serial('Linear rejects cyclic issue and comment continuations without committing a window', async () => {
  for (const resource of ['issues', 'comments']) {
    const cursors: unknown[] = []
    setFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      if (resource === 'comments' && body.query.includes('query Issues')) return Response.json({ data: { issues: {
        nodes: [{ id: 'a', updatedAt: '2026-01-01T00:00:00Z', comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'a' } } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } })
      cursors.push(body.variables.after)
      const connection = { nodes: [], pageInfo: { hasNextPage: true, endCursor: body.variables.after === 'a' ? 'b' : 'a' } }
      return resource === 'issues' ? Response.json({ data: { issues: connection } }) : Response.json({ data: { issue: { comments: connection } } })
    })
    const journal = createMemoryJournal()
    const result = await runIngestion({ selected: selected(), backfill: undefined }, { journal, destination: createMemoryDestination(), now: () => cutoff })
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.error).toContain('repeated continuation')
    expect(cursors).toHaveLength(3)
    expect((await journal.readCheckpoint('linear.issues')).envelope).toBeUndefined()
  }
})
