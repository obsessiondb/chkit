import { expect, test } from 'bun:test'
import { IngestConfigError, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { createCirclebackPipeline, circlebackPipeline } from '../index.js'
import { circlebackConfig, type CirclebackConfig } from '../config.js'
import { defaultCirclebackClientDeps } from '../client.js'

const cutoff = new Date('2026-01-02T00:00:00Z')
const resources = ['meetings', 'meeting_transcripts', 'action_items', 'people', 'companies']
const meeting = { id: 'meeting-a', name: 'Old meeting', updatedAt: '2020-01-01T00:00:00Z', notes: 'Provider notes',
  tags: [{ id: 10, name: 'Customer' }, { id: 11, name: 'Follow up' }], attendees: [{ profileId: 1 }],
  actionItems: [{ id: 252, status: 'PENDING' }], custom: { retained: true } }
const transcript = [{ speaker: null, text: 'Full transcript\nwith another line', timestamp: 0.25, custom: true }]
const pending = { id: 252, title: 'Follow up', status: 'PENDING', completedAt: null, assignee: { profileId: 1 }, meetingIds: ['meeting-a'], custom: true }
const done = { id: 253, title: 'Completed work', status: 'DONE', completedAt: '2020-01-01T00:00:00Z', assignee: null, meetingIds: [], custom: true }
const person = { id: 1, companyId: 3, firstName: 'John', lastName: 'Appleseed', email: 'john@initech.com', companyName: 'Initech', title: 'Operations', custom: true }
const personDetail = { ...person, externalLinks: [{ type: 'linkedin', objectType: 'person', url: 'https://www.linkedin.com/in/john-appleseed' }] }
const company = { domain: 'initech.com', name: 'Initech', avatarUrl: null, custom: true }
const companyDetail = { ...company, people: [person], externalLinks: [{ type: 'website', objectType: 'company', url: 'https://initech.com' }] }

type Pipeline = ReturnType<typeof createCirclebackPipeline>
type Responder = (url: URL, init: RequestInit) => Response | Promise<Response>

test('Circleback publishes five raw resources with scoped native IDs and string tag names', async () => {
  const calls: URL[] = [], pipeline = fixturePipeline((url, init) => { calls.push(url); return fixtureResponse(url, init) })
  expect(circlebackPipeline.streams).toHaveLength(5)
  expect(pipeline.streams.map((stream) => stream.id).sort()).toEqual(resources.map((resource) => `circleback.${resource}`).sort())
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const result = await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  const expected = {
    meetings: [{ id: rowId('meeting-a'), raw: envelope({ ...meeting, tags: ['Customer', 'Follow up'] }) }],
    meeting_transcripts: [
      { id: rowId('meeting-a'), raw: { source_id: 'circleback', kind: 'transcript', meeting_id: 'meeting-a', status: 'available', data: transcript } },
      { id: JSON.stringify(['circleback', 'meeting-a', 'availability']), raw: { source_id: 'circleback', meeting_id: 'meeting-a', kind: 'availability', status: 'available' } },
    ],
    action_items: [pending, done].map((data) => ({ id: rowId(data.id), raw: envelope(data) })),
    people: [{ id: rowId(person.id), raw: envelope(personDetail) }],
    companies: [{ id: rowId(company.domain), raw: { source_id: 'circleback', company_id: 3, data: companyDetail } }],
  }
  expect(destination.tables.size).toBe(5)
  for (const [resource, rows] of Object.entries(expected)) {
    expect(destination.tables.get(`default.circleback_${resource}_raw`)?.map(({ id, raw }) => ({ id, raw }))).toEqual(rows)
    expect((await journal.readCheckpoint(`circleback.${resource}`)).envelope).toBeUndefined()
    expect((await journal.readCheckpoint(`circleback.${resource}`)).lastSuccessSeq).toBeGreaterThan(0)
  }
  expect(calls.some((url) => url.pathname.includes('/calendar') || url.pathname.includes('/tags') || url.hostname !== 'circleback.ai')).toBe(false)
})

test('all resources run alone and reversing stream order preserves their raw observations', async () => {
  const pipeline = fixturePipeline(), combined = createMemoryDestination()
  expect((await runIngestion(request({ ...pipeline, streams: [...pipeline.streams].reverse() }),
    { journal: createMemoryJournal(), destination: combined, now: () => cutoff })).ok).toBe(true)
  for (const resource of resources) {
    const calls: URL[] = [], destination = createMemoryDestination()
    const isolated = fixturePipeline((url, init) => { calls.push(url); return fixtureResponse(url, init) })
    const selected = request(isolated, resource)
    expect(selected.selected.map((entry) => entry.stream.id)).toEqual([`circleback.${resource}`])
    expect((await runIngestion(selected, { journal: createMemoryJournal(), destination, now: () => cutoff })).ok).toBe(true)
    expect(destination.tables.size).toBe(1)
    expect(destination.tables.get(`default.circleback_${resource}_raw`)?.map(({ id, raw }) => ({ id, raw })))
      .toEqual(combined.tables.get(`default.circleback_${resource}_raw`)?.map(({ id, raw }) => ({ id, raw })))
    expect(calls).toHaveLength(resource === 'meetings' ? 1 : 2)
    if (resource === 'meetings') expect(calls.map((url) => url.pathname)).toEqual(['/api/meetings'])
    if (resource === 'action_items') expect(calls.every((url) => url.pathname === '/api/action-items')).toBe(true)
    if (resource === 'companies') expect(calls.map((url) => url.pathname)).toEqual(['/api/companies', '/api/company/initech.com'])
    if (resource === 'people') expect(calls.map((url) => url.pathname)).toEqual(['/api/people', '/api/person/1'])
  }
})

test('action items enumerate both native completion statuses for anyone and follow each partition to exhaustion', async () => {
  const calls: URL[] = []
  const pipeline = fixturePipeline((url) => {
    calls.push(url)
    expect(url.searchParams.get('assigneeType')).toBe('Anyone')
    const status = url.searchParams.get('status')
    expect(status === 'PENDING' || status === 'DONE').toBe(true)
    const item = status === 'PENDING' ? pending : done
    if (url.searchParams.has('cursor')) return Response.json([{ ...item, id: item.id + 10 }])
    return Response.json([item], { headers: { Link: `</api/action-items?assigneeType=Anyone&status=${status}&cursor=next>; rel="next"` } })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'action_items'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(calls.map((url) => [url.searchParams.get('status'), url.searchParams.get('cursor')])).toEqual([
    ['PENDING', null], ['PENDING', 'next'], ['DONE', null], ['DONE', 'next'],
  ])
  expect(destination.tables.get('default.circleback_action_items_raw')?.map((row) => row.id)).toEqual([252, 262, 253, 263].map((id) => rowId(id)))
  expect((await journal.readCheckpoint('circleback.action_items')).lastSuccessSeq).toBeGreaterThan(0)
})

test('cursor-only continuations retain ownership and completion filters and conflicting links fail visibly', async () => {
  for (const resource of ['meetings', 'action_items']) {
    const calls: URL[] = []
    const pipeline = fixturePipeline((url) => {
      calls.push(url)
      if (resource === 'action_items' && url.searchParams.get('status') === 'PENDING') return Response.json([])
      if (url.searchParams.has('cursor')) return Response.json(resource === 'meetings' ? [meeting] : [done])
      return Response.json([], { headers: { Link: `<${url.pathname}?cursor=next>; rel="next"` } })
    })
    expect((await runIngestion(request(pipeline, resource), { journal: createMemoryJournal(), destination: createMemoryDestination(), now: () => cutoff })).ok).toBe(true)
    const continued = calls.at(-1)
    expect(continued?.searchParams.get('cursor')).toBe('next')
    if (resource === 'meetings') expect(continued?.searchParams.get('ownership')).toBe('All')
    else {
      expect(continued?.searchParams.get('status')).toBe('DONE')
      expect(continued?.searchParams.get('assigneeType')).toBe('Anyone')
    }
  }
  for (const [resource, conflict] of [['meetings', 'ownership=Mine'], ['action_items', 'status=DONE'], ['action_items', 'assigneeType=Me']] satisfies [string, string][]) {
    let calls = 0
    const pipeline = fixturePipeline((url) => {
      calls++
      return Response.json([], { headers: { Link: `<${url.pathname}?cursor=next&${conflict}>; rel="next"` } })
    })
    const journal = createMemoryJournal()
    expect((await runIngestion(request(pipeline, resource), { journal, destination: createMemoryDestination(), now: () => cutoff })).ok).toBe(false)
    expect(calls).toBe(1)
    expect((await journal.readCheckpoint(`circleback.${resource}`)).lastSuccessSeq).toBe(0)
  }
})

test('late transcripts on unchanged old meetings are revisited without running the meetings stream', async () => {
  let available = false
  const starts: string[] = [], calls: string[] = []
  const pipeline = fixturePipeline((url) => {
    calls.push(url.pathname)
    if (url.pathname.endsWith('/transcript')) {
      if (!available) return new Response('unavailable', { status: url.pathname.includes('/meeting-a/') ? 403 : 404 })
      return Response.json(url.pathname.includes('/meeting-a/') ? transcript : [])
    }
    starts.push(url.search)
    return Response.json([meeting, { ...meeting, id: 'meeting-b' }])
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination(), selected = request(pipeline, 'meeting_transcripts')
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(destination.tables.get('default.circleback_meeting_transcripts_raw')?.map((row) => row.raw)).toEqual([
    { source_id: 'circleback', meeting_id: 'meeting-a', kind: 'availability', status: 'forbidden' },
    { source_id: 'circleback', meeting_id: 'meeting-b', kind: 'availability', status: 'not_found' },
  ])
  available = true
  expect((await runIngestion(selected, { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
  expect(starts).toEqual(['?ownership=All', '?ownership=All'])
  expect(calls.filter((path) => path.endsWith('/transcript'))).toHaveLength(4)
  expect(destination.tables.get('default.circleback_meeting_transcripts_raw')?.slice(-4).map((row) => row.raw)).toEqual([
    { source_id: 'circleback', kind: 'transcript', meeting_id: 'meeting-a', status: 'available', data: transcript },
    { source_id: 'circleback', meeting_id: 'meeting-a', kind: 'availability', status: 'available' },
    { source_id: 'circleback', kind: 'transcript', meeting_id: 'meeting-b', status: 'available', data: [] },
    { source_id: 'circleback', meeting_id: 'meeting-b', kind: 'availability', status: 'available' },
  ])
  expect((await journal.readCheckpoint('circleback.meetings')).lastSuccessSeq).toBe(0)
  expect((await journal.readCheckpoint('circleback.meeting_transcripts')).envelope).toBeUndefined()
})

test('forbidden and not-found observations preserve prior transcript content while a successful empty transcript replaces it', async () => {
  let status = 200, empty = false
  const pipeline = fixturePipeline((url) => url.pathname === '/api/meetings' ? Response.json([meeting])
    : status === 200 ? Response.json(empty ? [] : transcript) : new Response('unavailable', { status }))
  const journal = createMemoryJournal(), destination = createMemoryDestination(), selected = request(pipeline, 'meeting_transcripts')
  for (const nextStatus of [200, 403, 404, 200]) {
    status = nextStatus
    expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
    const snapshots = destination.tables.get('default.circleback_meeting_transcripts_raw')?.filter((row) => row.id === rowId(meeting.id)) ?? []
    expect(snapshots.at(-1)?.raw).toMatchObject({ kind: 'transcript', status: 'available', data: empty ? [] : transcript })
    if (status === 404) empty = true
  }
  const rows = destination.tables.get('default.circleback_meeting_transcripts_raw') ?? []
  expect(rows.filter((row) => row.id === rowId(meeting.id))).toHaveLength(2)
  expect(rows.filter((row) => row.id !== rowId(meeting.id)).map((row) => row.raw)).toEqual(
    ['available', 'forbidden', 'not_found', 'available'].map((status) => ({ source_id: 'circleback', meeting_id: meeting.id, kind: 'availability', status })))
  expect(new Set(rows.map((row) => row.id)).size).toBe(2)
})

test('a transcript source failure leaves its full sync incomplete while all other resource streams succeed', async () => {
  let fail = true
  const transcriptCalls: string[] = []
  const pipeline = fixturePipeline((url, init) => {
    if (url.pathname.endsWith('/transcript')) {
      transcriptCalls.push(url.pathname)
      if (fail) return new Response('unavailable', { status: 500 })
    }
    return fixtureResponse(url, init)
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const failed = await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })
  expect(failed.ok).toBe(false)
  expect(failed.streams.filter((stream) => stream.outcome === 'failed').map((stream) => stream.streamId)).toEqual(['circleback.meeting_transcripts'])
  expect(destination.tables.get('default.circleback_meetings_raw')?.[0]?.raw).toEqual(envelope({ ...meeting, tags: ['Customer', 'Follow up'] }))
  expect((await journal.readCheckpoint('circleback.meeting_transcripts')).lastSuccessSeq).toBe(0)
  for (const resource of resources.filter((resource) => resource !== 'meeting_transcripts')) {
    expect((await journal.readCheckpoint(`circleback.${resource}`)).lastSuccessSeq).toBeGreaterThan(0)
  }
  fail = false
  expect((await runIngestion(request(pipeline, 'meeting_transcripts'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(transcriptCalls).toEqual(['/api/meeting/meeting-a/transcript', '/api/meeting/meeting-a/transcript'])
})

test('a failed transcript write replays its own parent discovery before recording successful completion', async () => {
  const starts: string[] = []
  const pipeline = fixturePipeline((url, init) => {
    if (url.pathname === '/api/meetings') starts.push(url.search)
    return fixtureResponse(url, init)
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination(), selected = request(pipeline, 'meeting_transcripts')
  expect((await runIngestion(selected, { journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } }, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('circleback.meeting_transcripts')).lastSuccessSeq).toBe(0)
  expect((await journal.readCheckpoint('circleback.meeting_transcripts')).envelope).toBeUndefined()
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(starts).toEqual(['?ownership=All', '?ownership=All'])
  expect(destination.tables.get('default.circleback_meeting_transcripts_raw')).toHaveLength(2)
})

test('full meeting reads replay from page one after source and sink failures and retain changed observations', async () => {
  let fail = true, changed = false
  const starts: string[] = [], second = { ...meeting, id: 'meeting-b' }
  const pipeline = fixturePipeline((url) => {
    if (url.searchParams.has('cursor')) return fail ? new Response('denied', { status: 403 }) : Response.json([second])
    starts.push(url.search)
    return Response.json([{ ...meeting, notes: changed ? 'Edited without an updatedAt change' : meeting.notes }],
      { headers: { Link: '</api/meetings?cursor=next>; rel="next"' } })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination(), selected = request(pipeline, 'meetings')
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('circleback.meetings')).lastSuccessSeq).toBe(0)
  fail = false
  expect((await runIngestion(selected, { journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } }, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('circleback.meetings')).lastSuccessSeq).toBe(0)
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
  changed = true
  expect((await runIngestion(selected, { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
  expect(starts).toEqual(Array(4).fill('?ownership=All'))
  expect((await journal.readCheckpoint('circleback.meetings')).envelope).toBeUndefined()
  expect(destination.tables.get('default.circleback_meetings_raw')?.filter((row) => row.id === rowId('meeting-a')).map((row) => row.raw)).toEqual([
    envelope({ ...meeting, tags: ['Customer', 'Follow up'] }),
    envelope({ ...meeting, notes: 'Edited without an updatedAt change', tags: ['Customer', 'Follow up'] }),
  ])
})

test('empty full resources record completion and scan again without custom provider state', async () => {
  const calls: string[] = [], pipeline = fixturePipeline((url) => { calls.push(url.pathname); return Response.json([]) })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  for (const now of [cutoff, new Date('2026-01-03')]) {
    expect((await runIngestion(request(pipeline), { journal, destination, now: () => now })).ok).toBe(true)
  }
  expect(destination.tables.size).toBe(0)
  for (const resource of resources) {
    expect((await journal.readCheckpoint(`circleback.${resource}`)).envelope).toBeUndefined()
    expect(journal.events.filter((event) => event.namespaceId === `circleback.${resource}` && event.eventKind === 'work_finished' && event.workState === 'succeeded')).toHaveLength(2)
  }
  expect(calls.filter((path) => path === '/api/meetings')).toHaveLength(4)
  expect(calls.filter((path) => path === '/api/action-items')).toHaveLength(4)
})

test('company domains stay stable while optional native numeric IDs preserve downstream joins', async () => {
  let identified = false
  const pipeline = fixturePipeline((url) => url.pathname === '/api/companies'
    ? Response.json([{ ...company, ...(identified ? { id: 3 } : {}) }])
    : Response.json({ ...company, externalLinks: [], people: [] }))
  const journal = createMemoryJournal(), destination = createMemoryDestination(), selected = request(pipeline, 'companies')
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
  identified = true
  expect((await runIngestion(selected, { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
  const rows = destination.tables.get('default.circleback_companies_raw') ?? []
  expect(rows.map((row) => row.id)).toEqual([rowId('initech.com'), rowId('initech.com')])
  expect(rows.map((row) => row.raw)).toEqual([
    { source_id: 'circleback', company_id: null, data: { ...company, externalLinks: [], people: [] } },
    { source_id: 'circleback', company_id: 3, data: { ...company, id: 3, externalLinks: [], people: [] } },
  ])
  expect(new Set(rows.map((row) => row.id)).size).toBe(1)
})

test('company detail failures and conflicting native IDs cannot complete or fabricate company joins', async () => {
  for (const mode of ['forbidden', 'conflicting', 'different-domain']) {
    const pipeline = fixturePipeline((url) => {
      if (url.pathname === '/api/companies') return Response.json([{ ...company, id: 3 }])
      if (mode === 'forbidden') return new Response('denied', { status: 403 })
      return Response.json({ ...companyDetail, ...(mode === 'different-domain' ? { domain: 'other.example' } : { people: [{ ...person, companyId: 4 }] }) })
    })
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    expect((await runIngestion(request(pipeline, 'companies'), { journal, destination, now: () => cutoff })).ok).toBe(false)
    expect(destination.tables.size).toBe(0)
    expect((await journal.readCheckpoint('circleback.companies')).lastSuccessSeq).toBe(0)
  }
})

test('same-person detail retains raw external references and cannot publish a different or inaccessible person', async () => {
  for (const mode of ['denied', 'mismatched-id', 'missing-links']) {
    const calls: string[] = []
    const pipeline = fixturePipeline((url) => {
      calls.push(url.pathname)
      if (url.pathname === '/api/people') return Response.json([person])
      if (mode === 'denied') return new Response('denied', { status: 403 })
      return Response.json({ ...personDetail, ...(mode === 'mismatched-id' ? { id: 2 } : { externalLinks: null }) })
    })
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    expect((await runIngestion(request(pipeline, 'people'), { journal, destination, now: () => cutoff })).ok).toBe(false)
    expect(calls).toEqual(['/api/people', '/api/person/1'])
    expect(destination.tables.size).toBe(0)
    expect((await journal.readCheckpoint('circleback.people')).lastSuccessSeq).toBe(0)
  }
})

test('factory configuration, tokens and selected resource progress stay independent between installations', async () => {
  const config: CirclebackConfig = { ...circlebackConfig, sourceId: 'circleback.team', ownership: 'Shared' }
  const calls: URL[] = []
  const pipeline = createCirclebackPipeline(config, { ...defaultCirclebackClientDeps, token: () => 'team-key', fetch: async (url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer team-key')
    calls.push(new URL(url))
    return Response.json([meeting])
  } })
  config.sourceId = 'changed'
  config.ownership = 'Mine'
  const failing = createCirclebackPipeline({ ...circlebackConfig, sourceId: 'circleback.denied' }, {
    ...defaultCirclebackClientDeps, token: () => 'denied', fetch: async () => new Response('denied', { status: 403 }),
  })
  const selected = selectStreams([failing, pipeline], ['resource:meetings']).map((entry) => ({ ...entry, stream: { ...entry.stream, retry: { retries: 0 } } }))
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const result = await runIngestion({ selected, backfill: undefined }, { journal, destination, now: () => cutoff })
  expect(result.streams.map((stream) => stream.outcome)).toEqual(['failed', 'succeeded'])
  expect(calls.map((url) => url.searchParams.get('ownership'))).toEqual(['Shared'])
  expect(destination.tables.get('default.circleback_meetings_raw')?.[0]?.id).toBe(rowId(meeting.id, 'circleback.team'))
  expect(destination.tables.get('default.circleback_meetings_raw')?.[0]?.raw).toEqual(envelope({ ...meeting, tags: ['Customer', 'Follow up'] }, 'circleback.team'))
  expect((await journal.readCheckpoint('circleback.denied.meetings')).lastSuccessSeq).toBe(0)
  expect((await journal.readCheckpoint('circleback.team.meetings')).lastSuccessSeq).toBeGreaterThan(0)
  const onlyTeam = selectStreams([failing, pipeline], ['stream:circleback.team.meetings'])
  expect(onlyTeam.map((entry) => entry.stream.id)).toEqual(['circleback.team.meetings'])
  expect((await journal.readCheckpoint('circleback.meetings')).lastSuccessSeq).toBe(0)
})

test('empty Link pages continue while cyclic, cross-collection, foreign and malformed next links fail permanently', async () => {
  for (const mode of ['empty-first', 'cyclic', 'cross-collection', 'foreign', 'malformed', 'multiple-next']) {
    const calls: string[] = []
    const pipeline = fixturePipeline((url) => {
      if (url.pathname.startsWith('/api/person/')) return Response.json(personDetail)
      calls.push(url.toString())
      if (mode === 'empty-first' && url.searchParams.has('cursor')) return Response.json([person])
      const next = mode === 'foreign' ? 'https://untrusted.example/people' : mode === 'cross-collection' ? '/api/companies?cursor=next' : '/api/people?cursor=next'
      const link = mode === 'malformed' ? 'not-a-link; rel="next"' : mode === 'multiple-next' ? `<${next}>; rel="next", </api/people?cursor=another>; rel="next"` : `<${next}>; rel="next"`
      return Response.json([], { headers: { Link: link } })
    })
    const selected = request(pipeline, 'people').selected.map((entry) => ({ ...entry, stream: { ...entry.stream, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 } } }))
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    const result = await runIngestion({ selected, backfill: undefined }, { journal, destination, now: () => cutoff })
    expect(result.ok).toBe(mode === 'empty-first')
    expect(calls).toHaveLength(['empty-first', 'cyclic'].includes(mode) ? 2 : 1)
    expect((await journal.readCheckpoint('circleback.people')).lastSuccessSeq > 0).toBe(mode === 'empty-first')
    expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled')).toHaveLength(0)
  }
})

test('malformed collections, identities, tag names and unsupported action status cannot become successful full syncs', async () => {
  for (const [resource, payload] of [
    ['meetings', { error: 'bad payload' }], ['meetings', [{ ...meeting, id: '' }]], ['meetings', [{ ...meeting, tags: [{ id: 10 }] }]],
    ['people', [{ ...person, id: 1.5 }]], ['action_items', [{ ...pending, status: 'UNKNOWN' }]],
    ['action_items', [{ ...pending, status: 'DONE' }]], ['action_items', [{ ...pending, meetingIds: null }]],
  ] satisfies [string, unknown][]) {
    let calls = 0
    const pipeline = fixturePipeline(() => { calls++; return Response.json(payload) })
    const journal = createMemoryJournal()
    expect((await runIngestion(request(pipeline, resource), { journal, destination: createMemoryDestination(), now: () => cutoff })).ok).toBe(false)
    expect(calls).toBe(1)
    expect((await journal.readCheckpoint(`circleback.${resource}`)).lastSuccessSeq).toBe(0)
  }
})

test('HTTP200 malformed transcripts fail without publishing an availability snapshot or completing the stream', async () => {
  for (const payload of [null, { error: 'denied' }, [{ speaker: null, text: 'Words' }], [{ speaker: 3, text: 'Words', timestamp: 1 }], [{ speaker: null, text: {}, timestamp: 1 }]]) {
    let calls = 0
    const pipeline = fixturePipeline((url) => {
      if (url.pathname === '/api/meetings') return Response.json([meeting])
      calls++
      return Response.json(payload)
    })
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    expect((await runIngestion(request(pipeline, 'meeting_transcripts'), { journal, destination, now: () => cutoff })).ok).toBe(false)
    expect(calls).toBe(1)
    expect(destination.tables.size).toBe(0)
    expect((await journal.readCheckpoint('circleback.meeting_transcripts')).lastSuccessSeq).toBe(0)
  }
})

test('rate exhaustion consumes exactly one executor-owned page retry and malformed JSON remains permanent', async () => {
  for (const mode of ['rate', 'malformed-json']) {
    let calls = 0
    const pipeline = fixturePipeline((url) => {
      if (url.pathname.startsWith('/api/person/')) return Response.json(personDetail)
      calls++
      if (mode === 'malformed-json') return new Response('{', { headers: { 'Content-Type': 'application/json' } })
      return calls === 1 ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }) : Response.json([person])
    })
    const selected = request(pipeline, 'people').selected.map((entry) => ({ ...entry, stream: { ...entry.stream, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 } } }))
    const journal = createMemoryJournal()
    expect((await runIngestion({ selected, backfill: undefined }, { journal, destination: createMemoryDestination(), now: () => cutoff })).ok).toBe(mode === 'rate')
    expect(calls).toBe(mode === 'rate' ? 2 : 1)
    expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled')).toHaveLength(mode === 'rate' ? 1 : 0)
  }
})

function fixturePipeline(respond: Responder = fixtureResponse): Pipeline {
  return createCirclebackPipeline(circlebackConfig, { ...defaultCirclebackClientDeps, token: () => 'fixture',
    fetch: (url, init) => Promise.resolve(respond(new URL(url), init)) })
}

function request(pipeline: Pipeline, resource?: string) {
  return { selected: selectStreams([pipeline], resource ? [`resource:${resource}`] : []).map((entry) => ({
    ...entry, stream: { ...entry.stream, batchSize: 1, retry: { retries: 0 } },
  })), backfill: undefined }
}

function fixtureResponse(url: URL, _init: RequestInit): Response {
  if (url.pathname === '/api/meetings') return Response.json([meeting])
  if (url.pathname.endsWith('/transcript')) return Response.json(transcript)
  if (url.pathname === '/api/action-items') return Response.json(url.searchParams.get('status') === 'DONE' ? [done] : [pending])
  if (url.pathname === '/api/people') return Response.json([person])
  if (url.pathname === '/api/person/1') return Response.json(personDetail)
  if (url.pathname === '/api/companies') return Response.json([company])
  if (url.pathname === '/api/company/initech.com') return Response.json(companyDetail)
  throw new IngestConfigError(`Unexpected Circleback fixture request: ${url}`)
}

function rowId(id: string | number, sourceId = 'circleback'): string { return JSON.stringify([sourceId, id]) }
function envelope(data: unknown, sourceId = 'circleback') { return { source_id: sourceId, data } }
