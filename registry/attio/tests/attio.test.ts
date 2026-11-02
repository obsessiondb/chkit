import { describe, expect, test } from 'bun:test'

import { HttpError, definePipeline, runIngestion, selectStreams, type PipelineDefinition } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import type { AttioReaderConfig } from '../config.js'
import * as definitions from '../index.js'
import { attio, createAttioPipeline } from '../pipeline.js'
import { attioEnv, fixtureConfig, fixtureResponse, peopleObject, person } from './fixtures.js'

const people = ['resource:records', 'object:people']

describe('Attio template', () => {
  test('exports independently selectable object streams and raw destinations without credentials', () => {
    const exported = Object.values(definitions)
    expect(exported).toContain(attio)
    expect(attio.streams).toHaveLength(9)
    expect(attio.streams.filter((stream) => stream.tags.includes('resource:records')).map((stream) => stream.id))
      .toEqual(['attio.primary.records.people', 'attio.primary.records.companies'])
    expect(selectStreams([attio], people).map(({ stream }) => stream.id)).toEqual(['attio.primary.records.people'])
    expect(selectStreams([attio], ['resource:records', 'object:companies']).map(({ stream }) => stream.id))
      .toEqual(['attio.primary.records.companies'])
    for (const stream of attio.streams) {
      expect(exported).toContain(stream.destination)
      expect(stream.incremental.id).toBe('chkit.full_sync')
    }
    expect([definitions.attioPeople, definitions.attioCompanies, definitions.attioDeals].map((view) => view.name))
      .toEqual(['attio_people', 'attio_companies', 'attio_deals'])
  })

  test('an object named tasks does not overlap the workspace tasks resource tag', () => {
    const pipeline = createAttioPipeline({ ...fixtureConfig, objects: ['tasks'], lists: [] })
    expect(selectStreams([pipeline], ['resource:tasks']).map(({ stream }) => stream.id)).toEqual(['attio.primary.tasks'])
    expect(selectStreams([pipeline], ['resource:records', 'object:tasks']).map(({ stream }) => stream.id))
      .toEqual(['attio.primary.records.tasks'])
  })

  test('configured custom objects and lists have their own streams sharing raw tables', async () => {
    const pipeline = fixturePipeline()
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const result = await runIngestion(request(pipeline), { ...attioEnv(), journal, destination })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(pipeline.streams).toHaveLength(11)
    expect(result.streams.filter((stream) => stream.streamId.includes('.records.')).map((stream) => stream.rows)).toEqual([1, 1])
    expect(destination.tables.size).toBe(9)
    expect(destination.tables.get('default.attio_records_raw')?.map((row) => row.raw)).toContainEqual({
      source_id: 'attio.primary', object_slug: 'people', data: person,
    })
    expect(destination.tables.get('default.attio_entries_raw')?.[0]?.raw).toMatchObject({ list_slug: 'sales' })
    expect(selectStreams([pipeline], ['resource:records', 'object:subscriptions']).map(({ stream }) => stream.id))
      .toEqual(['attio.primary.records.subscriptions'])
    expect(selectStreams([pipeline], ['resource:entries']).map(({ stream }) => stream.id))
      .toEqual(['attio.primary.entries.sales'])
  })

  test('one object reader paginates only that object and preserves raw custom values and IDs', async () => {
    const requests: Array<{ path: string; body: unknown }> = []
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ ...person, id: { ...person.id, record_id: `record-${index}` } }))
    const env = attioEnv((url, init) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      requests.push({ path: url.pathname, body })
      if (url.pathname === '/v2/objects/people') return Response.json({ data: peopleObject })
      if (url.pathname === '/v2/objects/object-people/records/query') {
        return Response.json({ data: body.offset === 0 ? firstPage : [{ ...person, id: { ...person.id, record_id: 'last' } }] })
      }
      throw new Error(`Unexpected URL ${url.pathname}`)
    })
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const result = await runIngestion(request(fixturePipeline(), people), { ...env, journal, destination })
    expect(result.streams.map((stream) => [stream.outcome, stream.rows, stream.chunks])).toEqual([['succeeded', 501, 2]])
    expect(requests).toEqual([
      { path: '/v2/objects/people', body: undefined },
      { path: '/v2/objects/object-people/records/query', body: { limit: 500, offset: 0 } },
      { path: '/v2/objects/object-people/records/query', body: { limit: 500, offset: 500 } },
    ])
    expect((await journal.readCheckpoint('attio.primary.records.people')).envelope).toBeUndefined()
    const rows = destination.tables.get('default.attio_records_raw') ?? []
    expect(rows[0]?.id).toBe(JSON.stringify(['attio.primary', 'records', 'workspace-1', 'object-people', 'record-0']))
    expect(rows[0]?.raw).toMatchObject({ data: { values: { custom_multi: [{ value: 'one' }, { value: 'two' }] } } })
    const custom = createMemoryDestination()
    const subscriptions = await runIngestion(request(fixturePipeline(), ['resource:records', 'object:subscriptions']), {
      ...attioEnv(), journal: createMemoryJournal(), destination: custom,
    })
    expect(subscriptions.ok).toBe(true)
    const customRow = custom.tables.get('default.attio_records_raw')?.[0]
    expect(customRow?.raw).toMatchObject({ object_slug: 'subscriptions' })
    expect(customRow?.id).not.toBe(rows[0]?.id)
  })

  test('a source identity and token supplied to the pipeline own stream IDs, raw row IDs and requests', async () => {
    const config = { ...fixtureConfig, sourceId: 'attio.secondary', objects: ['people'], lists: [], pageSize: 2, apiToken: 'secondary-token' }
    const queries: unknown[] = []
    const authorizations = new Set<string | null>()
    const env = attioEnv((url, init) => {
      authorizations.add(new Headers(init.headers).get('Authorization'))
      if (url.pathname.endsWith('/records/query')) queries.push(JSON.parse(String(init.body)))
      return fixtureResponse(url)
    })
    const pipeline = createAttioPipeline(config)
    config.sourceId = 'changed-after-construction'
    config.pageSize = 500
    config.objects.push('companies')
    config.apiToken = 'changed'
    const destination = createMemoryDestination()
    const result = await runIngestion(request(pipeline, people), { ...env, journal: createMemoryJournal(), destination })
    expect(result.ok).toBe(true)
    expect(result.streams[0]?.streamId).toBe('attio.secondary.records.people')
    const row = destination.tables.get('default.attio_records_raw')?.[0]
    expect(row?.id).toBe(JSON.stringify(['attio.secondary', 'records', 'workspace-1', 'object-people', 'record-1']))
    expect(row?.raw).toMatchObject({ source_id: 'attio.secondary' })
    expect(queries).toEqual([{ limit: 2, offset: 0 }])
    expect([...authorizations]).toEqual(['Bearer secondary-token'])
    expect(selectStreams([pipeline], ['resource:records']).map(({ stream }) => stream.id)).toEqual(['attio.secondary.records.people'])
  })

  test('notes use their 50-item limit and stop fetching after cancellation', async () => {
    const controller = new AbortController()
    const requests: URL[] = []
    const page = Array.from({ length: 50 }, (_, index) => ({ id: { workspace_id: 'workspace-1', note_id: `note-${index}` } }))
    const env = attioEnv((url) => {
      requests.push(url)
      controller.abort(new Error('fixture cancelled'))
      return Response.json({ data: page })
    })
    const pipeline = fixturePipeline()
    const result = await runIngestion(request(pipeline, ['resource:notes']), {
      ...env, signal: controller.signal, journal: createMemoryJournal(), destination: createMemoryDestination(),
    })
    expect(result.streams[0]?.outcome).toBe('cancelled')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.searchParams.get('limit')).toBe('50')
  })

  test('GET offset pagination requests the terminating empty page for an exact multiple', async () => {
    const offsets: Array<string | null> = []
    const env = attioEnv((url) => {
      const offset = url.searchParams.get('offset')
      offsets.push(offset)
      return Response.json({ data: offset === '0' ? [task('a'), task('b')] : [] })
    })
    const result = await runIngestion(request(fixturePipeline({ ...fixtureConfig, pageSize: 2 }), ['resource:tasks']), {
      ...env, journal: createMemoryJournal(), destination: createMemoryDestination(),
    })
    expect(result.streams.map((stream) => [stream.outcome, stream.rows, stream.chunks])).toEqual([['succeeded', 2, 2]])
    expect(offsets).toEqual(['0', '2'])
  })

  test('malformed successful responses and missing identities fail visibly', async () => {
    for (const [payload, message] of [
      [{}, 'expected array, received undefined'],
      [{ data: null }, 'expected array, received null'],
      [{ data: [{ id: { task_id: 'task-1' } }] }, 'expected string, received undefined'],
      [{ data: [{ id: { workspace_id: 'workspace-1', task_id: '' } }] }, 'Too small'],
    ] as const) {
      expect(await streamError(['resource:tasks'], () => Response.json(payload))).toContain(message)
    }
    expect(await streamError(people, (url) => url.pathname === '/v2/objects/people'
      ? fixtureResponse(url) : Response.json({ data: [{ ...person, values: { name: 'not-an-array' } }] }))).toContain('expected array, received string')
    expect(await streamError(people, () => Response.json({ data: [peopleObject] }))).toContain('expected object, received array')
    expect(await streamError(people, () => Response.json({ data: { ...peopleObject, api_slug: '' } }))).toContain('Too small')
  })

  test.each(['workspace_id', 'object_id'])('object readers reject children with a different %s', async (field) => {
    expect(await streamError(people, (url) => url.pathname === '/v2/objects/people'
      ? fixtureResponse(url) : Response.json({ data: [{ ...person, id: { ...person.id, [field]: 'foreign' } }] }))).toContain('different workspace or parent')
  })

  test('list readers resolve one list and reject entries belonging to another list', async () => {
    const requests: string[] = []
    const env = attioEnv((url) => {
      requests.push(url.pathname)
      return fixtureResponse(url)
    })
    const destination = createMemoryDestination()
    const result = await runIngestion(request(fixturePipeline(), ['resource:entries']), { ...env, journal: createMemoryJournal(), destination })
    expect(result.ok).toBe(true)
    expect(requests).toEqual(['/v2/lists/sales', '/v2/lists/list-sales/entries/query'])
    expect(destination.tables.get('default.attio_entries_raw')?.[0]?.raw).toMatchObject({ list_slug: 'sales' })
    expect(await streamError(['resource:entries'], (url) => url.pathname === '/v2/lists/sales'
      ? fixtureResponse(url) : Response.json({ data: [{ id: { workspace_id: 'workspace-1', list_id: 'foreign', entry_id: 'one' }, entry_values: {} }] })))
      .toContain('different workspace or parent')
  })

  test('permission failures fail one object stream while another remains independent', async () => {
    const requests: string[] = []
    const env = attioEnv((url) => {
      requests.push(url.pathname)
      return url.pathname === '/v2/objects/object-custom/records/query'
        ? Response.json({ code: 'insufficient_scope' }, { status: 403 }) : fixtureResponse(url)
    })
    const destination = createMemoryDestination()
    const journal = createMemoryJournal()
    const result = await runIngestion(request(fixturePipeline(), ['resource:records']), { ...env, journal, destination })
    expect(result.ok).toBe(false)
    expect(result.streams.map((stream) => [stream.streamId, stream.outcome, stream.rows])).toEqual([
      ['attio.primary.records.people', 'succeeded', 1], ['attio.primary.records.subscriptions', 'failed', 0],
    ])
    expect(result.streams[1]?.error).toContain('resource scopes')
    expect(requests.filter((path) => path === '/v2/objects/object-custom/records/query')).toHaveLength(1)
    expect(destination.tables.get('default.attio_records_raw')).toHaveLength(1)
    expect((await journal.readCheckpoint('attio.primary.records.people')).lastSuccessSeq).toBeGreaterThan(0)
    expect((await journal.readCheckpoint('attio.primary.records.subscriptions')).lastSuccessSeq).toBe(0)
  })

  test('429 retries remain under executor authority and retain Retry-After', async () => {
    let calls = 0
    const env = attioEnv((url) => {
      calls += 1
      return calls === 1 ? Response.json({ code: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '0' } }) : fixtureResponse(url)
    })
    const journal = createMemoryJournal()
    const result = await runIngestion(request(fixturePipeline(), ['resource:notes']), { ...env, journal, destination: createMemoryDestination() })
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
    expect(journal.events.some((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toBe(true)
    const http = await HttpError.fromResponse(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
    expect(http.retryAfterMs).toBe(2_000)
  })

  test('a missing token fails each stream before any request', async () => {
    let requests = 0
    const pipeline = createAttioPipeline({ ...fixtureConfig, apiToken: undefined })
    const env = attioEnv(() => { requests += 1; return Response.json({}) })
    const result = await runIngestion(request(pipeline), { ...env, journal: createMemoryJournal(), destination: createMemoryDestination() })
    expect(result.streams).toHaveLength(9)
    expect(result.streams.every((stream) => stream.outcome === 'failed' && stream.error?.includes('Set ATTIO_API_TOKEN or pass apiToken.'))).toBe(true)
    expect(requests).toBe(0)
  })

  test('an interrupted object restarts offset zero without requesting other objects', async () => {
    let fail = true
    const requests: string[] = []
    const offsets: number[] = []
    const page = Array.from({ length: 500 }, (_, index) => ({ ...person, id: { ...person.id, record_id: `record-${index}` } }))
    const env = attioEnv((url, init) => {
      requests.push(url.pathname)
      if (url.pathname === '/v2/objects/people') return fixtureResponse(url)
      if (url.pathname !== '/v2/objects/object-people/records/query') throw new Error(`Unexpected object request ${url.pathname}`)
      const { offset } = JSON.parse(String(init.body))
      offsets.push(offset)
      if (offset === 0) return Response.json({ data: page })
      return fail ? Response.json({ code: 'insufficient_scope' }, { status: 403 }) : Response.json({ data: [] })
    })
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const first = await runIngestion(request(fixturePipeline(), people), { ...env, journal, destination })
    expect(first.ok).toBe(false)
    expect((await journal.readCheckpoint('attio.primary.records.people')).envelope).toBeUndefined()
    fail = false
    const restored = await restoredJournal(journal)
    const resumed = await runIngestion(request(fixturePipeline(), people), { ...env, journal: restored, destination })
    expect(resumed.ok).toBe(true)
    expect(offsets).toEqual([0, 500, 0, 500])
    expect(requests).not.toContain('/v2/objects')
    expect(destination.tables.get('default.attio_records_raw')).toHaveLength(500)
  })

  test('reruns publish changed observations with the same stable raw ID', async () => {
    let changed = false
    const env = attioEnv((url) => url.pathname === '/v2/objects/object-people/records/query'
      ? Response.json({ data: [{ ...person, values: { ...person.values, name: [{ full_name: changed ? 'Ada Updated' : 'Ada Example' }] } }] }) : fixtureResponse(url))
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const selected = request(fixturePipeline(), people)
    expect((await runIngestion(selected, { ...env, journal, destination })).ok).toBe(true)
    changed = true
    expect((await runIngestion(selected, { ...env, journal, destination })).ok).toBe(true)
    const rows = destination.tables.get('default.attio_records_raw') ?? []
    expect(rows).toHaveLength(2)
    expect(rows[0]?.id).toBe(rows[1]?.id)
    expect(rows[1]?.raw).toMatchObject({ data: { values: { name: [{ full_name: 'Ada Updated' }] } } })
  })

  test('a fresh runtime after a lost journal acknowledgement replays changed rows safely', async () => {
    let changed = false
    const env = attioEnv((url) => url.pathname === '/v2/objects/object-people/records/query'
      ? Response.json({ data: [{ ...person, values: { ...person.values, revision: [{ value: changed ? 'new' : 'old' }] } }] }) : fixtureResponse(url))
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const failingJournal = {
      ...journal,
      async append(events: Parameters<typeof journal.append>[0]) {
        if (events.some((event) => event.eventKind === 'batch_committed' && Number(event.detail.rows) > 0)) {
          throw new Error('fixture journal unavailable after rows loaded')
        }
        await journal.append(events)
      },
    }
    const failed = await runIngestion(request(fixturePipeline(), people), { ...env, journal: failingJournal, destination })
    expect(failed.ok).toBe(false)
    expect(destination.tables.get('default.attio_records_raw')).toHaveLength(1)
    changed = true
    const resumed = await runIngestion(request(fixturePipeline(), people), { ...env, journal: await restoredJournal(journal), destination })
    expect(resumed.ok).toBe(true)
    const rows = destination.tables.get('default.attio_records_raw') ?? []
    expect(rows).toHaveLength(2)
    expect(rows[0]?.id).toBe(rows[1]?.id)
    expect(rows[1]?.raw).toMatchObject({ data: { values: { revision: [{ value: 'new' }] } } })
  }, 10_000)

  test('invalid configuration imports cleanly and fails each stream when it runs, before any request', async () => {
    let requests = 0
    const pipeline = createAttioPipeline({ ...fixtureConfig, pageSize: 0, notesPageSize: 100 })
    const selected = selectStreams([pipeline], [])
    expect(selected).toHaveLength(9)
    const env = attioEnv(() => { requests += 1; return Response.json({}) })
    const result = await runIngestion({ selected, backfill: undefined }, { ...env, journal: createMemoryJournal(), destination: createMemoryDestination() })
    expect(result.streams.every((stream) => stream.outcome === 'failed' && /at pageSize[\s\S]*at notesPageSize/.test(stream.error ?? ''))).toBe(true)
    expect(requests).toBe(0)
  })

  test('a malformed payload fails at once while a transient response is retried', async () => {
    let calls = 0
    const malformed = attioEnv((url) => { calls += 1; return url.pathname === '/v2/tasks' ? Response.json({ data: 'not-a-list' }) : fixtureResponse(url) })
    const journal = createMemoryJournal()
    const result = await runIngestion(request(fixturePipeline(), ['resource:tasks']), { ...malformed, journal, destination: createMemoryDestination() })
    expect(result.streams[0]?.outcome).toBe('failed')
    expect(result.streams[0]?.error).toContain('Invalid input: expected array, received string')
    expect(calls).toBe(1)
    expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled')).toHaveLength(0)

    let unavailable = true
    const flaky = attioEnv((url) => {
      if (unavailable) { unavailable = false; return new Response('busy', { status: 503 }) }
      return fixtureResponse(url)
    })
    const recovered = createMemoryJournal()
    const retried = await runIngestion(request(fixturePipeline(), ['resource:tasks']), { ...flaky, journal: recovered, destination: createMemoryDestination() })
    expect(retried.ok).toBe(true)
    expect(recovered.events.filter((event) => event.eventKind === 'retry_scheduled').map((event) => event.errorClass)).toEqual(['transient'])
  })
})

function fixturePipeline(config: AttioReaderConfig = { ...fixtureConfig, objects: ['people', 'subscriptions'], lists: ['sales'] }) {
  return definePipeline({
    ...createAttioPipeline(config),
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0, randomize: false },
  })
}

function request(pipeline: PipelineDefinition, tags: readonly string[] = []) {
  return { selected: selectStreams([pipeline], tags), backfill: undefined }
}

async function streamError(tags: readonly string[], respond: Parameters<typeof attioEnv>[0]): Promise<string | undefined> {
  const result = await runIngestion(request(fixturePipeline(), tags), { ...attioEnv(respond), journal: createMemoryJournal(), destination: createMemoryDestination() })
  expect(result.streams.map((stream) => stream.outcome)).toEqual(['failed'])
  return result.streams[0]?.error
}

function task(id: string) {
  return { id: { workspace_id: 'workspace-1', task_id: id } }
}

async function restoredJournal(previous: ReturnType<typeof createMemoryJournal>) {
  const journal = createMemoryJournal()
  await journal.append(previous.events.map((event) => ({
    ...event, checkpoint: event.checkpoint === undefined ? undefined : JSON.parse(JSON.stringify(event.checkpoint)),
  })))
  return journal
}
