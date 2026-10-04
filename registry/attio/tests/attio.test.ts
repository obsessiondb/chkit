import { describe, expect, test } from 'bun:test'

import { HttpError, definePipeline, runIngestion, selectStreams, type FetchContext } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { classifyAttioError, readCollection, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'
import * as definitions from '../index.js'
import { attio, createAttioPipeline } from '../pipeline.js'
import { readEntries } from '../sources/entries.js'
import { readMembers } from '../sources/members.js'
import { readNotes } from '../sources/notes.js'
import { readRecords } from '../sources/records.js'
import { readTasks } from '../sources/tasks.js'
import { fixtureDeps, fixtureResponse, peopleObject, person } from './fixtures.js'

describe('Attio template', () => {
  test('exports independently selectable object streams and raw destinations without credentials', () => {
    const exported = Object.values(definitions)
    expect(exported).toContain(attio)
    expect(attio.streams).toHaveLength(9)
    expect(attio.streams.filter((stream) => stream.tags.includes('resource:records')).map((stream) => stream.id))
      .toEqual(['attio.primary.records.people', 'attio.primary.records.companies'])
    expect(selectStreams([attio], ['resource:records', 'object:people']).map(({ stream }) => stream.id)).toEqual(['attio.primary.records.people'])
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
    const pipeline = createAttioPipeline({ ...attioConfig, objects: ['tasks'], lists: [] }, fixtureDeps())
    expect(selectStreams([pipeline], ['resource:tasks']).map(({ stream }) => stream.id)).toEqual(['attio.primary.tasks'])
    expect(selectStreams([pipeline], ['resource:records', 'object:tasks']).map(({ stream }) => stream.id))
      .toEqual(['attio.primary.records.tasks'])
  })

  test('configured custom objects and lists have their own streams sharing raw tables', async () => {
    const pipeline = fixturePipeline(fixtureDeps())
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal, destination })
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
    const deps = fixtureDeps((url, init) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      requests.push({ path: url.pathname, body })
      if (url.pathname === '/v2/objects/people') return Response.json({ data: peopleObject })
      if (url.pathname === '/v2/objects/object-people/records/query') {
        return Response.json({ data: body.offset === 0 ? firstPage : [{ ...person, id: { ...person.id, record_id: 'last' } }] })
      }
      throw new Error(`Unexpected URL ${url.pathname}`)
    })
    const chunks = await collect(readRecords(context(), 'people', deps))
    expect(chunks.map((chunk) => chunk.rows.length)).toEqual([500, 1])
    expect(requests).toEqual([
      { path: '/v2/objects/people', body: undefined },
      { path: '/v2/objects/object-people/records/query', body: { limit: 500, offset: 0 } },
      { path: '/v2/objects/object-people/records/query', body: { limit: 500, offset: 500 } },
    ])
    expect(chunks.every((chunk) => !('state' in chunk) && !('id' in chunk))).toBe(true)
    expect(chunks[0]?.rows[0]?.id).toBe(JSON.stringify(['attio.primary', 'records', 'workspace-1', 'object-people', 'record-0']))
    expect(chunks[0]?.rows[0]?.raw).toMatchObject({ data: { values: { custom_multi: [{ value: 'one' }, { value: 'two' }] } } })
    const custom = await collect(readRecords(context(), 'subscriptions', fixtureDeps()))
    expect(custom[0]?.rows[0]?.raw).toMatchObject({ object_slug: 'subscriptions' })
    expect(custom[0]?.rows[0]?.id).not.toBe(chunks[0]?.rows[0]?.id)
  })

  test('a source identity supplied to the pipeline owns stream IDs and raw row IDs', async () => {
    const pipeline = createAttioPipeline({ ...attioConfig, sourceId: 'attio.secondary', objects: ['people'], lists: [] }, fixtureDeps())
    const destination = createMemoryDestination()
    const result = await runIngestion({ selected: selectStreams([pipeline], ['resource:records', 'object:people']), backfill: undefined }, {
      journal: createMemoryJournal(), destination,
    })
    expect(result.ok).toBe(true)
    expect(result.streams[0]?.streamId).toBe('attio.secondary.records.people')
    const row = destination.tables.get('default.attio_records_raw')?.[0]
    expect(row?.id).toBe(JSON.stringify(['attio.secondary', 'records', 'workspace-1', 'object-people', 'record-1']))
    expect(row?.raw).toMatchObject({ source_id: 'attio.secondary' })
  })

  test('notes use their 50-item limit and stop fetching after cancellation', async () => {
    const controller = new AbortController()
    const waits: number[] = []
    const urls: string[] = []
    const page = Array.from({ length: 50 }, (_, index) => ({ id: { workspace_id: 'workspace-1', note_id: `note-${index}` } }))
    const deps = fixtureDeps((url) => { urls.push(url.toString()); return Response.json({ data: page }) })
    deps.wait = async (milliseconds, signal) => { waits.push(milliseconds); signal.throwIfAborted() }
    const iterator = readNotes(context(controller.signal), deps)
    expect((await iterator.next()).value?.rows).toHaveLength(50)
    controller.abort(new Error('fixture cancelled'))
    await expect(iterator.next()).rejects.toThrow('fixture cancelled')
    expect(urls).toHaveLength(1)
    expect(new URL(urls[0] ?? '').searchParams.get('limit')).toBe('50')
    expect(waits).toEqual([125])
  })

  test('GET offset pagination requests the terminating empty page for an exact multiple', async () => {
    const offsets: string[] = []
    const deps = fixtureDeps((url) => {
      const offset = url.searchParams.get('offset') ?? ''
      offsets.push(offset)
      return Response.json({ data: offset === '0' ? [{ id: { task_id: 'a' } }, { id: { task_id: 'b' } }] : [] })
    })
    const pages = await collect(readCollection(context(), { path: '/tasks', idFields: ['task_id'], pageSize: 2 }, deps))
    expect(pages.map((page) => page.length)).toEqual([2])
    expect(offsets).toEqual(['0', '2'])
  })

  test('malformed successful responses and missing identities fail visibly', async () => {
    for (const payload of [{}, { data: null }, { data: [{ id: { task_id: 'task-1' } }] }]) {
      await expect(collect(readTasks(context(), fixtureDeps(() => Response.json(payload))))).rejects.toThrow('Attio')
    }
    const malformed = fixtureDeps((url) => url.pathname === '/v2/objects/people'
      ? fixtureResponse(url) : Response.json({ data: [{ ...person, values: { name: 'not-an-array' } }] }))
    await expect(collect(readRecords(context(), 'people', malformed))).rejects.toThrow('invalid values')
    await expect(collect(readRecords(context(), 'people', fixtureDeps(() => Response.json({ data: [peopleObject] }))))).rejects.toThrow('Attio')
  })

  test.each(['workspace_id', 'object_id'])('object readers reject children with a different %s', async (field) => {
    const deps = fixtureDeps((url) => url.pathname === '/v2/objects/people'
      ? fixtureResponse(url) : Response.json({ data: [{ ...person, id: { ...person.id, [field]: 'foreign' } }] }))
    await expect(collect(readRecords(context(), 'people', deps))).rejects.toThrow('different workspace or parent')
  })

  test('list readers resolve one list and reject entries belonging to another list', async () => {
    const requests: string[] = []
    const deps = fixtureDeps((url) => {
      requests.push(url.pathname)
      return fixtureResponse(url)
    })
    const chunks = await collect(readEntries(context(), 'sales', deps))
    expect(requests).toEqual(['/v2/lists/sales', '/v2/lists/list-sales/entries/query'])
    expect(chunks[0]?.rows[0]?.raw).toMatchObject({ list_slug: 'sales' })
    const invalid = fixtureDeps((url) => url.pathname === '/v2/lists/sales'
      ? fixtureResponse(url) : Response.json({ data: [{ id: { workspace_id: 'workspace-1', list_id: 'foreign', entry_id: 'one' }, entry_values: {} }] }))
    await expect(collect(readEntries(context(), 'sales', invalid))).rejects.toThrow('different workspace or parent')
  })

  test('permission failures fail one object stream while another remains independent', async () => {
    const requests: string[] = []
    const deps = fixtureDeps((url) => {
      requests.push(url.pathname)
      return url.pathname === '/v2/objects/object-custom/records/query'
        ? Response.json({ code: 'insufficient_scope' }, { status: 403 }) : fixtureResponse(url)
    })
    const pipeline = fixturePipeline(deps)
    const destination = createMemoryDestination()
    const journal = createMemoryJournal()
    const result = await runIngestion({ selected: selectStreams([pipeline], ['resource:records']), backfill: undefined }, { journal, destination })
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
    const deps = fixtureDeps((url) => {
      calls += 1
      return calls === 1 ? Response.json({ code: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '0' } }) : fixtureResponse(url)
    })
    const journal = createMemoryJournal()
    const result = await runIngestion({ selected: selectStreams([fixturePipeline(deps)], ['resource:notes']), backfill: undefined }, {
      journal, destination: createMemoryDestination(),
    })
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
    expect(journal.events.some((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toBe(true)
    const http = await HttpError.fromResponse(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
    expect(http.retryAfterMs).toBe(2_000)
    expect(classifyAttioError(http, { kind: 'rate_limited', retryAfterMs: 2_000 })).toBeUndefined()
  })

  test('a missing token fails only when a reader runs', async () => {
    const deps = fixtureDeps(() => { throw new Error('must not fetch') })
    deps.token = () => undefined
    expect(attio.streams).toHaveLength(9)
    await expect(collect(readMembers(context(), deps))).rejects.toThrow('Set ATTIO_API_TOKEN')
  })

  test('an interrupted object restarts offset zero without requesting other objects', async () => {
    let fail = true
    const requests: string[] = []
    const offsets: number[] = []
    const page = Array.from({ length: 500 }, (_, index) => ({ ...person, id: { ...person.id, record_id: `record-${index}` } }))
    const deps = fixtureDeps((url, init) => {
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
    const first = await runIngestion({ selected: selectStreams([fixturePipeline(deps)], ['resource:records', 'object:people']), backfill: undefined }, { journal, destination })
    expect(first.ok).toBe(false)
    expect((await journal.readCheckpoint('attio.primary.records.people')).envelope).toBeUndefined()
    fail = false
    const restored = await restoredJournal(journal)
    const resumed = await runIngestion({ selected: selectStreams([fixturePipeline(deps)], ['resource:records', 'object:people']), backfill: undefined }, { journal: restored, destination })
    expect(resumed.ok).toBe(true)
    expect(offsets).toEqual([0, 500, 0, 500])
    expect(requests).not.toContain('/v2/objects')
    expect(destination.tables.get('default.attio_records_raw')).toHaveLength(500)
  })

  test('reruns publish changed observations with the same stable raw ID', async () => {
    let changed = false
    const deps = fixtureDeps((url) => url.pathname === '/v2/objects/object-people/records/query'
      ? Response.json({ data: [{ ...person, values: { ...person.values, name: [{ full_name: changed ? 'Ada Updated' : 'Ada Example' }] } }] }) : fixtureResponse(url))
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const request = { selected: selectStreams([fixturePipeline(deps)], ['resource:records', 'object:people']), backfill: undefined }
    expect((await runIngestion(request, { journal, destination })).ok).toBe(true)
    changed = true
    expect((await runIngestion(request, { journal, destination })).ok).toBe(true)
    const rows = destination.tables.get('default.attio_records_raw') ?? []
    expect(rows).toHaveLength(2)
    expect(rows[0]?.id).toBe(rows[1]?.id)
    expect(rows[1]?.raw).toMatchObject({ data: { values: { name: [{ full_name: 'Ada Updated' }] } } })
  })

  test('a fresh runtime after a lost journal acknowledgement replays changed rows safely', async () => {
    let changed = false
    const deps = fixtureDeps((url) => url.pathname === '/v2/objects/object-people/records/query'
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
    const failed = await runIngestion({ selected: selectStreams([fixturePipeline(deps)], ['resource:records', 'object:people']), backfill: undefined }, {
      journal: failingJournal, destination,
    })
    expect(failed.ok).toBe(false)
    expect(destination.tables.get('default.attio_records_raw')).toHaveLength(1)
    changed = true
    const resumed = await runIngestion({ selected: selectStreams([fixturePipeline(deps)], ['resource:records', 'object:people']), backfill: undefined }, {
      journal: await restoredJournal(journal), destination,
    })
    expect(resumed.ok).toBe(true)
    const rows = destination.tables.get('default.attio_records_raw') ?? []
    expect(rows).toHaveLength(2)
    expect(rows[0]?.id).toBe(rows[1]?.id)
    expect(rows[1]?.raw).toMatchObject({ data: { values: { revision: [{ value: 'new' }] } } })
  }, 10_000)
})

function fixturePipeline(deps: AttioClientDeps) {
  return definePipeline({
    ...createAttioPipeline({ ...attioConfig, objects: ['people', 'subscriptions'], lists: ['sales'] }, deps),
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0, randomize: false },
  })
}

function context(signal = new AbortController().signal): FetchContext {
  return { signal, attempt: async (operation) => operation(signal) }
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

async function restoredJournal(previous: ReturnType<typeof createMemoryJournal>) {
  const journal = createMemoryJournal()
  await journal.append(previous.events.map((event) => ({
    ...event, checkpoint: event.checkpoint === undefined ? undefined : JSON.parse(JSON.stringify(event.checkpoint)),
  })))
  return journal
}
