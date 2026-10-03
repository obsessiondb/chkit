import { describe, expect, test } from 'bun:test'

import { HttpError, definePipeline, runIngestion, selectStreams, type FetchContext, type SourceChunk } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { classifyAttioError, readCollection, type AttioClientDeps } from '../attio/client.js'
import * as definitions from '../attio/index.js'
import { readEntries, readListAttributes, readLists } from '../attio/lists/read.js'
import { readMembers } from '../attio/members/read.js'
import { readObjectAttributes, readObjects } from '../attio/metadata/read.js'
import { readNotes } from '../attio/notes/read.js'
import { attio } from '../attio/pipeline.js'
import { readRecords } from '../attio/records/read.js'
import { readTasks } from '../attio/tasks/read.js'
import { customObject, fixtureCollections, fixtureDeps, peopleObject, person } from './fixtures.js'

const readers: Record<string, (context: FetchContext, deps: AttioClientDeps) => AsyncIterable<SourceChunk>> = {
  objects: readObjects, object_attributes: readObjectAttributes, records: readRecords,
  lists: readLists, list_attributes: readListAttributes, entries: readEntries,
  notes: readNotes, tasks: readTasks, members: readMembers,
}

describe('Attio template', () => {
  test('exports every stream destination and all three views without reading credentials', () => {
    const exported = Object.values(definitions)
    expect(exported).toContain(attio)
    expect(attio.streams).toHaveLength(9)
    for (const stream of attio.streams) {
      expect(exported).toContain(stream.destination)
      expect(stream.incremental.id).toBe('chkit.full_sync')
    }
    expect([definitions.attioPeople, definitions.attioCompanies, definitions.attioDeals].map((view) => view.name))
      .toEqual(['attio_people', 'attio_companies', 'attio_deals'])
  })

  test('all streams ingest sanitized fixtures and reruns publish changed observations', async () => {
    let changed = false
    const deps = fixtureDeps((url) => {
      const data = fixtureCollections[url.pathname]
      if (data === undefined) throw new Error(`Unexpected fixture URL: ${url.pathname}`)
      return Response.json({ data: changed && url.pathname === '/v2/notes'
        ? [{ id: { workspace_id: 'workspace-1', note_id: 'note-1' }, content_markdown: '# Revised call' }]
        : data })
    })
    const pipeline = fixturePipeline(deps)
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const request = { selected: selectStreams([pipeline], []), backfill: undefined }
    const first = await runIngestion(request, { journal, destination })
    expect(first.ok).toBe(true)
    expect(first.streams.map((stream) => stream.rows)).toEqual([2, 2, 2, 1, 1, 1, 1, 1, 1])
    expect(destination.tables.size).toBe(9)
    expect(destination.tables.get('default.attio_records_raw')?.map((row) => row.raw)).toContainEqual({
      source_id: 'attio.primary', object_slug: 'people', data: person,
    })
    changed = true
    const second = await runIngestion(request, { journal, destination })
    expect(second.ok).toBe(true)
    const notes = destination.tables.get('default.attio_notes_raw') ?? []
    expect(notes).toHaveLength(2)
    expect(notes[0]?.id).toBe(notes[1]?.id)
    expect(notes[1]?.raw).toMatchObject({ data: { content_markdown: '# Revised call' } })
  })

  test('records discover parents independently and read all offset pages including custom objects', async () => {
    const requests: Array<{ path: string; body: unknown }> = []
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ ...person, id: { ...person.id, record_id: `record-${index}` } }))
    const deps = fixtureDeps((url, init) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      requests.push({ path: url.pathname, body })
      if (url.pathname === '/v2/objects') return Response.json({ data: [peopleObject, customObject] })
      if (url.pathname === '/v2/objects/object-people/records/query') {
        return Response.json({ data: body.offset === 0 ? firstPage : [{ ...person, id: { ...person.id, record_id: 'last' } }] })
      }
      if (url.pathname === '/v2/objects/object-custom/records/query') {
        return Response.json({ data: [{ id: { ...person.id, object_id: 'object-custom' }, values: {} }] })
      }
      throw new Error(`Unexpected URL ${url.pathname}`)
    })
    const chunks = await collect(readRecords(context(), deps))
    expect(chunks.map((chunk) => chunk.rows.length)).toEqual([500, 1, 1])
    expect(requests.map((request) => request.body)).toEqual([undefined, { limit: 500, offset: 0 }, { limit: 500, offset: 500 }, { limit: 500, offset: 0 }])
    expect(chunks.every((chunk) => !('state' in chunk) && !('id' in chunk))).toBe(true)
    expect(chunks[0]?.rows[1]?.id).not.toBe(chunks[2]?.rows[0]?.id)
  })

  test('notes use their 50-item page limit, honor cancellation, and never fetch a second page after abort', async () => {
    const controller = new AbortController()
    const waits: number[] = []
    const urls: string[] = []
    const page = Array.from({ length: 50 }, (_, index) => ({ id: { workspace_id: 'workspace-1', note_id: `note-${index}` } }))
    const deps = fixtureDeps((url) => { urls.push(url.toString()); return Response.json({ data: page }) })
    deps.wait = async (milliseconds, signal) => { waits.push(milliseconds); signal.throwIfAborted() }
    const iterator = readNotes(context(controller.signal), deps)
    const first = await iterator.next()
    expect(first.value?.rows).toHaveLength(50)
    controller.abort(new Error('fixture cancelled'))
    await expect(iterator.next()).rejects.toThrow('fixture cancelled')
    expect(urls).toHaveLength(1)
    expect(new URL(urls[0] ?? '').searchParams.get('limit')).toBe('50')
    expect(waits).toEqual([125])
  })

  test('GET pagination includes the terminating empty page for an exact multiple', async () => {
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

  test('malformed successful responses and missing identity fail rather than become empty data', async () => {
    for (const payload of [{}, { data: null }, { data: [{ id: { task_id: 'task-1' } }] }]) {
      const deps = fixtureDeps(() => Response.json(payload))
      await expect(collect(readTasks(context(), deps))).rejects.toThrow('Attio')
    }
    const malformedRecord = fixtureDeps((url) => Response.json({ data: url.pathname === '/v2/objects'
      ? [peopleObject] : [{ ...person, values: { name: 'not-an-array' } }] }))
    await expect(collect(readRecords(context(), malformedRecord))).rejects.toThrow('invalid values')
  })

  test('permission failures are permanent, actionable, and produce no rows', async () => {
    let calls = 0
    const deps = fixtureDeps(() => { calls += 1; return Response.json({ code: 'insufficient_scope' }, { status: 403 }) })
    const pipeline = fixturePipeline(deps, ['notes'])
    const destination = createMemoryDestination()
    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, {
      journal: createMemoryJournal(), destination,
    })
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.error).toContain('resource scopes')
    expect(result.streams[0]?.rows).toBe(0)
    expect(calls).toBe(1)
    expect(destination.tables.size).toBe(0)
  })

  test('429 requests retry under executor authority and preserve Retry-After', async () => {
    let calls = 0
    const deps = fixtureDeps(() => {
      calls += 1
      return calls === 1
        ? Response.json({ code: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json({ data: fixtureCollections['/v2/notes'] })
    })
    const pipeline = fixturePipeline(deps, ['notes'])
    const journal = createMemoryJournal()
    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, {
      journal, destination: createMemoryDestination(),
    })
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
    expect(journal.events.some((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toBe(true)
    const http = await HttpError.fromResponse(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
    expect(http.retryAfterMs).toBe(2_000)
    expect(classifyAttioError(http, { kind: 'rate_limited', retryAfterMs: 2_000 })).toBeUndefined()
  })

  test('a missing token fails only when the reader runs', async () => {
    const deps = fixtureDeps(() => { throw new Error('must not fetch') })
    deps.token = () => undefined
    expect(attio.streams).toHaveLength(9)
    await expect(collect(readMembers(context(), deps))).rejects.toThrow('Set ATTIO_API_TOKEN')
  })
})

function fixturePipeline(deps: AttioClientDeps, selectedResources?: readonly string[]) {
  return definePipeline({
    ...attio,
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0, randomize: false },
    streams: attio.streams.filter((stream) => selectedResources === undefined || selectedResources.includes(stream.id.split('.').at(-1) ?? '')).map((stream) => {
      const read = readers[stream.id.split('.').at(-1) ?? '']
      if (!read) throw new Error(`No fixture reader for ${stream.id}`)
      return { ...stream, read: (context: FetchContext) => read(context, deps) }
    }),
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
