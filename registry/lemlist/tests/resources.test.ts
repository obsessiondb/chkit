import { expect, test } from 'bun:test'
import { runIngestion, selectStreams, type PipelineDefinition } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { lemlistConfig } from '../config.js'
import { createLemlistPipeline } from '../index.js'

const resources = ['activities', 'campaigns', 'contacts', 'companies', 'campaign_leads', 'inbox_conversations', 'inbox_messages']
const now = () => new Date('2026-01-02T00:00:00Z')
const fixtureConfig = { ...lemlistConfig, sourceId: 'lemlist.fixture', start: new Date('2026-01-01'), apiKey: 'fixture' }

function pipeline(options: { pageSize?: number; inboxUserIds?: readonly string[] } = {}) {
  return createLemlistPipeline({ ...fixtureConfig, ...options })
}

function lemlistFetch(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response> = fixture) {
  return async (input: string | URL, init?: RequestInit) => handler(new URL(input), init)
}

function selected(value: PipelineDefinition, resource?: string) {
  return selectStreams([value], resource ? [`resource:${resource}`] : [])
    .map((item) => ({ ...item, stream: { ...item.stream, retry: { retries: 0 } } }))
}

function listing(data: { _id: string; [key: string]: unknown }[], url: URL, total = data.length) {
  return Response.json({ data, total, limit: Number(url.searchParams.get('limit')), offset: Number(url.searchParams.get('offset')) })
}

function inbox(data: { _id: string; [key: string]: unknown }[], options: { page?: number; next?: number | null; total?: number; limit?: number } = {}) {
  return Response.json({ data, pagination: {
    totalItems: options.total ?? data.length, currentPage: options.page ?? 1, nextPage: options.next ?? null,
    previousPage: null, perPage: options.limit ?? 100, totalPages: options.next ? options.next : options.page ?? (data.length ? 1 : 0),
  } })
}

function fixture(url: URL): Response {
  switch (url.pathname) {
    case '/api/activities': return Response.json([{ _id: 'act', type: 'emailsSent', createdAt: '2026-01-01T12:00:00Z' }])
    case '/api/campaigns': return Response.json([{ _id: 'cam', createdAt: '2000-01-01', name: 'Outreach' }])
    case '/api/contacts': return url.searchParams.has('idsOrEmails') ? Response.json([{
      _id: 'ctc', companyId: 'cpn', fields: { custom: 'kept' }, unsubscribed: false,
      campaigns: [{ campaignId: 'cam', leadId: 'lea', leadState: 'review' }],
    }]) : listing([{ _id: 'ctc' }], url)
    case '/api/companies': return listing([{ _id: 'cpn', fields: { name: 'Company', custom: { kept: true } } }], url)
    case '/api/v2/campaigns/cam/export/leads': return Response.json([{ _id: 'lea', email: 'person@example.com', lastState: 'emailsReplied', custom: 'kept' }])
    case '/api/team': return Response.json({ _id: 'tea', userIds: ['usr'] })
    case '/api/inbox': return inbox([{ _id: 'ibx', contactId: 'ctc', users: [{ userId: 'usr', read: false }], channels: ['email'] }])
    case '/api/inbox/ctc': return inbox([{ _id: 'message', type: 'emailsReplied', contactId: 'ctc', leadId: 'lea', campaignId: 'cam', message: '<p>Reply</p>' }])
    default: throw new Error(`Unexpected fixture request: ${url.pathname}`)
  }
}

test('Lemlist has seven independently selectable resources with raw provider IDs and joins', async () => {
  const paths: string[] = []
  const fetch = lemlistFetch((url, init) => {
    expect(init?.method ?? 'GET').toBe('GET')
    paths.push(url.pathname)
    return fixture(url)
  })
  const value = pipeline()
  expect(value.streams.map((stream) => stream.id)).toEqual(resources.map((resource) => `lemlist.fixture.${resource}`))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  expect((await runIngestion({ selected: selected(value).reverse(), backfill: undefined }, { fetch, journal, destination, now })).ok).toBe(true)
  expect(paths.filter((path) => path === '/api/contacts')).toHaveLength(3)
  expect(destination.tables.get('default.lemlist_contacts_raw')?.[0]).toMatchObject({
    id: '["lemlist.fixture","ctc"]', raw: { source_id: 'lemlist.fixture', data: { companyId: 'cpn', fields: { custom: 'kept' }, campaigns: [{ campaignId: 'cam', leadId: 'lea' }] } },
  })
  expect(destination.tables.get('default.lemlist_campaign_leads_raw')?.[0]).toMatchObject({
    id: '["lemlist.fixture","cam","lea"]', raw: { source_id: 'lemlist.fixture', campaign_id: 'cam', data: { _id: 'lea', lastState: 'emailsReplied', custom: 'kept' } },
  })
  expect(destination.tables.get('default.lemlist_inbox_messages_raw')?.[0]).toMatchObject({
    id: '["lemlist.fixture","ctc","message"]', raw: { source_id: 'lemlist.fixture', contact_id: 'ctc', data: { message: '<p>Reply</p>', leadId: 'lea' } },
  })
  for (const resource of resources) expect((await journal.readCheckpoint(`lemlist.fixture.${resource}`)).lastSuccessSeq).toBeGreaterThan(0)
})

for (const resource of resources) {
  test(`Lemlist ${resource} discovers its own scope when selected alone`, async () => {
    const fetch = lemlistFetch()
    const value = pipeline()
    const journal = createMemoryJournal()
    expect((await runIngestion({ selected: selected(value, resource), backfill: undefined }, { fetch, journal, destination: createMemoryDestination(), now })).ok).toBe(true)
    expect(journal.events.filter((event) => event.namespaceId.startsWith('lemlist.fixture.'))
      .every((event) => event.namespaceId === `lemlist.fixture.${resource}`)).toBe(true)
  })
}

test('Lemlist exports more than 500 campaign leads without calling the capped list endpoint', async () => {
  const paths: URL[] = []
  const fetch = lemlistFetch((url) => {
    paths.push(url)
    if (url.pathname.endsWith('/export/leads')) {
      expect(url.searchParams.get('state')).toBe('all')
      expect(url.searchParams.get('format')).toBe('json')
      return Response.json(Array.from({ length: 501 }, (_, index) => ({ _id: `lea-${index}`, custom: index })))
    }
    return fixture(url)
  })
  const value = pipeline()
  const destination = createMemoryDestination()
  expect((await runIngestion({ selected: selected(value, 'campaign_leads'), backfill: undefined }, { fetch, journal: createMemoryJournal(), destination, now })).ok).toBe(true)
  expect(destination.tables.get('default.lemlist_campaign_leads_raw')).toHaveLength(501)
  expect(paths.map((url) => url.pathname)).toEqual(['/api/campaigns', '/api/v2/campaigns/cam/export/leads'])
})

test('Lemlist full-contact hydration fails visibly when a discovered contact is unavailable', async () => {
  const fetch = lemlistFetch((url) => url.searchParams.has('idsOrEmails') ? Response.json([]) : fixture(url))
  const value = pipeline()
  const journal = createMemoryJournal()
  const result = await runIngestion({ selected: selected(value, 'contacts'), backfill: undefined }, { fetch, journal, destination: createMemoryDestination(), now })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('every discovered contact')
  expect((await journal.readCheckpoint('lemlist.fixture.contacts')).lastSuccessSeq).toBe(0)
})

test('Lemlist scoped conversation users are snapshotted and pagination follows provider pages', async () => {
  const userIds = ['usr-selected']
  const config = { ...fixtureConfig, pageSize: 2, inboxUserIds: userIds }
  const urls: URL[] = []
  const fetch = lemlistFetch((url) => {
    urls.push(url)
    expect(url.pathname).toBe('/api/inbox')
    expect(url.searchParams.get('userId')).toBe('usr-selected')
    const page = Number(url.searchParams.get('page'))
    return inbox([{ _id: `conversation-${page}` }], { page, next: page === 1 ? 2 : null, total: 2, limit: 2 })
  })
  const value = createLemlistPipeline(config)
  userIds[0] = 'changed'
  config.pageSize = 100
  const destination = createMemoryDestination()
  expect((await runIngestion({ selected: selected(value, 'inbox_conversations'), backfill: undefined }, { fetch, journal: createMemoryJournal(), destination, now })).ok).toBe(true)
  expect(urls.map((url) => [url.searchParams.get('page'), url.searchParams.get('limit')])).toEqual([['1', '2'], ['2', '2']])
  expect(destination.tables.get('default.lemlist_inbox_conversations_raw')?.map((row) => row.id)).toEqual([
    '["lemlist.fixture","usr-selected","conversation-1"]', '["lemlist.fixture","usr-selected","conversation-2"]',
  ])
})

test('Lemlist messages revisit old contacts and use skip pagination without marking anything read', async () => {
  let body = 'before'
  const skips: string[] = []
  const fetch = lemlistFetch((url, init) => {
    expect(init?.method ?? 'GET').toBe('GET')
    if (url.pathname.startsWith('/api/inbox/')) {
      expect(url.searchParams.get('markAsRead')).toBe('false')
      expect(url.searchParams.has('minDate')).toBe(false)
      skips.push(url.searchParams.get('skip') ?? '')
      const page = url.searchParams.get('skip') === '0' ? 1 : 2
      return inbox([{ _id: `message-${page}`, createdAt: '2000-01-01', message: body }], { page, next: page === 1 ? 2 : null, total: 2, limit: 2 })
    }
    return listing([{ _id: 'ctc', createdAt: '2000-01-01' }], url)
  })
  const value = pipeline({ pageSize: 2 })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selected(value, 'inbox_messages'), backfill: undefined }
  expect((await runIngestion(request, { fetch, journal, destination, now })).ok).toBe(true)
  body = 'edited reply'
  expect((await runIngestion(request, { fetch, journal, destination, now })).ok).toBe(true)
  expect(skips).toEqual(['0', '2', '0', '2'])
  expect(destination.tables.get('default.lemlist_inbox_messages_raw')?.map((row) => row.raw)).toContainEqual({
    source_id: 'lemlist.fixture', contact_id: 'ctc', data: { _id: 'message-1', createdAt: '2000-01-01', message: 'edited reply' },
  })
})

for (const resource of ['contacts', 'companies', 'campaign_leads', 'inbox_conversations', 'inbox_messages']) {
  test(`Lemlist ${resource} safely replays destination failure from its own discovery`, async () => {
    const paths: string[] = []
    const fetch = lemlistFetch((url) => { paths.push(url.pathname); return fixture(url) })
    const value = pipeline()
    const journal = createMemoryJournal()
    const request = { selected: selected(value, resource), backfill: undefined }
    expect((await runIngestion(request, { fetch, journal, destination: { insert: async () => { throw new Error('sink denied') } }, now })).ok).toBe(false)
    expect((await journal.readCheckpoint(`lemlist.fixture.${resource}`)).lastSuccessSeq).toBe(0)
    const first = [...paths]
    paths.length = 0
    expect((await runIngestion(request, { fetch, journal, destination: createMemoryDestination(), now })).ok).toBe(true)
    expect(paths).toEqual(first)
  })
}

test('Lemlist empty full collections record completion without custom scan state', async () => {
  const fetch = lemlistFetch((url) => {
    if (url.pathname === '/api/contacts' || url.pathname === '/api/companies') {
      expect(url.searchParams.has('idsOrEmails')).toBe(false)
      return listing([], url)
    }
    if (url.pathname === '/api/team') return Response.json({ users: [{ userId: 'usr' }] })
    if (url.pathname === '/api/inbox') return inbox([])
    return Response.json([])
  })
  const value = pipeline()
  const journal = createMemoryJournal()
  expect((await runIngestion({ selected: selected(value), backfill: undefined }, { fetch, journal, destination: createMemoryDestination(), now })).ok).toBe(true)
  for (const resource of resources) expect((await journal.readCheckpoint(`lemlist.fixture.${resource}`)).lastSuccessSeq).toBeGreaterThan(0)
})

for (const malformed of ['missing', 'repeated', 'truncated', 'invalid-export']) {
  test(`Lemlist rejects ${malformed} continuation/export without successful completion`, async () => {
    const resource = malformed === 'invalid-export' ? 'campaign_leads' : 'inbox_conversations'
    const fetch = lemlistFetch((url) => {
      if (malformed === 'invalid-export' && url.pathname.endsWith('/export/leads')) return Response.json({ data: [{ _id: 'capped' }], next: 'unknown' })
      if (url.pathname === '/api/inbox') {
        const page = Number(url.searchParams.get('page'))
        if (malformed === 'missing') return Response.json({ data: [], pagination: { totalItems: 0 } })
        return inbox([{ _id: `conversation-${page}` }], { page, next: malformed === 'repeated' ? page : null, total: 3 })
      }
      return fixture(url)
    })
    const value = pipeline()
    const journal = createMemoryJournal()
    expect((await runIngestion({ selected: selected(value, resource), backfill: undefined }, { fetch, journal, destination: createMemoryDestination(), now })).ok).toBe(false)
    expect((await journal.readCheckpoint(`lemlist.fixture.${resource}`)).lastSuccessSeq).toBe(0)
  })
}

for (const resource of ['contacts', 'companies']) {
  test(`Lemlist ${resource} consumes every advertised offset page`, async () => {
    const offsets: string[] = []
    const fetch = lemlistFetch((url) => {
      if (url.searchParams.has('idsOrEmails')) {
        const ids = url.searchParams.get('idsOrEmails')?.split(',') ?? []
        return Response.json(ids.map((_id) => ({ _id, fields: { custom: 'complete' } })))
      }
      offsets.push(url.searchParams.get('offset') ?? '')
      const offset = Number(url.searchParams.get('offset'))
      return listing(offset === 0 ? [{ _id: 'first' }, { _id: 'second' }] : [{ _id: 'last' }], url, 3)
    })
    const value = pipeline({ pageSize: 2 })
    const destination = createMemoryDestination()
    expect((await runIngestion({ selected: selected(value, resource), backfill: undefined }, { fetch, journal: createMemoryJournal(), destination, now })).ok).toBe(true)
    expect(offsets).toEqual(['0', '2'])
    expect(destination.tables.get(`default.lemlist_${resource}_raw`)?.map((row) => row.id)).toEqual(
      ['first', 'second', 'last'].map((id) => JSON.stringify(['lemlist.fixture', id])))
  })
}

test('Lemlist keeps distinct user inbox observations when native conversation IDs match', async () => {
  const fetch = lemlistFetch((url) => inbox([{ _id: 'shared', unread: url.searchParams.get('userId') === 'usr-a' }]))
  const value = pipeline({ inboxUserIds: ['usr-a', 'usr-b'] })
  const destination = createMemoryDestination()
  expect((await runIngestion({ selected: selected(value, 'inbox_conversations'), backfill: undefined }, { fetch, journal: createMemoryJournal(), destination, now })).ok).toBe(true)
  expect(destination.tables.get('default.lemlist_inbox_conversations_raw')?.map((row) => [row.id, row.raw])).toEqual([
    ['["lemlist.fixture","usr-a","shared"]', { source_id: 'lemlist.fixture', user_id: 'usr-a', data: { _id: 'shared', unread: true } }],
    ['["lemlist.fixture","usr-b","shared"]', { source_id: 'lemlist.fixture', user_id: 'usr-b', data: { _id: 'shared', unread: false } }],
  ])
})

test('Lemlist interrupted message traversal restarts contact discovery and skip zero', async () => {
  let fail = true
  const paths: string[] = []
  const fetch = lemlistFetch((url) => {
    paths.push(url.pathname + (url.searchParams.has('skip') ? `:${url.searchParams.get('skip')}` : ''))
    if (url.pathname === '/api/inbox/ctc') {
      const page = url.searchParams.get('skip') === '0' ? 1 : 2
      if (fail && page === 2) return new Response('denied', { status: 403 })
      return inbox([{ _id: `message-${page}` }], { page, next: page === 1 ? 2 : null, total: 2, limit: 2 })
    }
    return fixture(url)
  })
  const value = pipeline({ pageSize: 2 })
  const journal = createMemoryJournal()
  const request = { selected: selected(value, 'inbox_messages'), backfill: undefined }
  const destination = createMemoryDestination()
  expect((await runIngestion(request, { fetch, journal, destination, now })).ok).toBe(false)
  expect((await journal.readCheckpoint('lemlist.fixture.inbox_messages')).lastSuccessSeq).toBe(0)
  fail = false
  expect((await runIngestion(request, { fetch, journal, destination, now })).ok).toBe(true)
  expect(paths).toEqual(['/api/contacts', '/api/inbox/ctc:0', '/api/inbox/ctc:2', '/api/contacts', '/api/inbox/ctc:0', '/api/inbox/ctc:2'])
})

test('Lemlist refuses a shortened contact listing that still advertises more records', async () => {
  const fetch = lemlistFetch((url) => listing([{ _id: 'first' }], url, 3))
  const value = pipeline({ pageSize: 2 })
  const journal = createMemoryJournal()
  expect((await runIngestion({ selected: selected(value, 'contacts'), backfill: undefined }, { fetch, journal, destination: createMemoryDestination(), now })).ok).toBe(false)
  expect((await journal.readCheckpoint('lemlist.fixture.contacts')).lastSuccessSeq).toBe(0)
})

for (const resource of ['contacts', 'companies', 'inbox_conversations']) {
  test(`Lemlist ${resource} refuses partially overlapping pages despite matching advertised totals`, async () => {
    const fetch = lemlistFetch((url) => {
      if (url.searchParams.has('idsOrEmails')) return Response.json((url.searchParams.get('idsOrEmails')?.split(',') ?? []).map((_id) => ({ _id })))
      const first = resource === 'inbox_conversations' ? url.searchParams.get('page') === '1' : url.searchParams.get('offset') === '0'
      const items = first ? [{ _id: 'a' }, { _id: 'b' }] : [{ _id: 'b' }, { _id: 'c' }]
      return resource === 'inbox_conversations'
        ? inbox(items, { page: first ? 1 : 2, next: first ? 2 : null, total: 4, limit: 2 })
        : listing(items, url, 4)
    })
    const value = pipeline({ pageSize: 2, inboxUserIds: ['usr'] })
    const journal = createMemoryJournal()
    const result = await runIngestion({ selected: selected(value, resource), backfill: undefined }, { fetch, journal, destination: createMemoryDestination(), now })
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.error).toContain('object ID')
    expect((await journal.readCheckpoint(`lemlist.fixture.${resource}`)).lastSuccessSeq).toBe(0)
  })
}

test('Lemlist fails a missing API key in every stream before any request without retrying', async () => {
  let requests = 0
  const journal = createMemoryJournal()
  const value = createLemlistPipeline({ ...fixtureConfig, apiKey: undefined })
  const result = await runIngestion({ selected: selectStreams([value], []), backfill: undefined }, { fetch: lemlistFetch(() => { requests += 1; return Response.json([]) }), journal, destination: createMemoryDestination(), now })
  expect(result.streams).toHaveLength(7)
  expect(result.streams.every((stream) => stream.outcome === 'failed' && stream.error?.includes('Set LEMLIST_API_KEY or pass apiKey.'))).toBe(true)
  expect(requests).toBe(0)
  expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled')).toHaveLength(0)
})

test('Lemlist checks its configuration when a stream runs, not when the module loads or a stream is selected', async () => {
  let requests = 0
  const value = createLemlistPipeline({ ...fixtureConfig, pageSize: 500, start: new Date(Number.NaN), intervalMs: 0, inboxUserIds: ['usr', 'usr'] })
  const streams = selectStreams([value], [])
  expect(streams).toHaveLength(7)
  const result = await runIngestion({ selected: streams, backfill: undefined }, { fetch: lemlistFetch(() => { requests += 1; return Response.json([]) }), journal: createMemoryJournal(), destination: createMemoryDestination(), now })
  expect(result.streams).toHaveLength(7)
  expect(result.streams.every((stream) => stream.outcome === 'failed')).toBe(true)
  const activities = result.streams.find((stream) => stream.streamId.endsWith('.activities'))
  const others = result.streams.filter((stream) => stream !== activities)
  expect(activities?.error).toBe('timestampWindow: start must be a valid Date.')
  expect(others.every((stream) => /at pageSize[\s\S]*at start[\s\S]*at intervalMs[\s\S]*at inboxUserIds/.test(stream.error ?? ''))).toBe(true)
  expect(requests).toBe(0)
})

test('Lemlist fails a malformed provider payload at once and retries only a transient response', async () => {
  const run = async (companies: (url: URL) => Response) => {
    const fetch = lemlistFetch((url) => url.pathname === '/api/companies' ? companies(url) : fixture(url))
    const value = pipeline()
    const journal = createMemoryJournal()
    const result = await runIngestion({ selected: selectStreams([{ ...value, retry: { retries: 2, minTimeout: 0 } }], ['resource:companies']), backfill: undefined }, { fetch, journal, destination: createMemoryDestination(), now })
    return { result, retries: journal.events.filter((event) => event.eventKind === 'retry_scheduled').map((event) => event.errorClass) }
  }

  let calls = 0
  const malformed = await run((url) => { calls += 1; return Response.json({ data: 'not-a-list', total: 0, limit: 100, offset: Number(url.searchParams.get('offset')) }) })
  expect(malformed.result.streams[0]?.outcome).toBe('failed')
  expect(malformed.result.streams[0]?.error).toContain('Invalid input: expected array, received string')
  expect(calls).toBe(1)
  expect(malformed.retries).toEqual([])

  let unavailable = true
  const flaky = await run((url) => {
    if (unavailable) { unavailable = false; return new Response('busy', { status: 503 }) }
    return fixture(url)
  })
  expect(flaky.result.ok).toBe(true)
  expect(flaky.retries).toEqual(['transient'])
})
