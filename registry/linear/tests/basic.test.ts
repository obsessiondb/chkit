import { expect, test } from 'bun:test'
import { IngestConfigError, runIngestion, selectStreams, type FetchContext, type Page } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { createLinearPipeline, linearPipeline } from '../index.js'
import { linearConfig, type LinearConfig } from '../config.js'
import type { LinearObject } from '../client.js'
import { readLinearPages } from '../sources/common.js'

const cutoff = new Date('2026-01-02T00:00:00Z')
const updatedAt = '2026-01-01T12:00:00Z'
const resources = ['issues', 'comments', 'projects', 'project_updates', 'cycles', 'users', 'teams', 'issue_relations', 'issue_history']
const timestampResources = resources.slice(0, 7)
const issue = { id: 'issue-a', identifier: 'ENG-1', title: 'Archived issue', updatedAt, archivedAt: updatedAt,
  team: { id: 'team-a' }, assignee: { id: 'user-a' }, project: { id: 'project-a' }, cycle: { id: 'cycle-a' },
  custom: { retained: true }, labels: connection([{ id: 'label-a', name: 'Bug' }, { id: 'label-b', name: 'Customer' }]) }
const comment = { id: 'comment-a', body: 'Discussion', updatedAt, issueId: 'issue-a', projectUpdateId: null, user: { id: 'user-a' }, custom: ['retained'] }
const project = { id: 'project-a', name: 'Project', updatedAt, archivedAt: updatedAt, lead: { id: 'user-a' }, status: { id: 'status-a', name: 'Started' }, custom: true }
const projectUpdate = { id: 'project-update-a', body: 'Progress', updatedAt, project: { id: 'project-a' }, user: { id: 'user-a' }, custom: true }
const cycle = { id: 'cycle-a', number: 7, updatedAt, archivedAt: updatedAt, team: { id: 'team-a' }, custom: true }
const user = { id: 'user-a', name: 'Disabled user', updatedAt, active: false, organization: { id: 'organization-a' }, custom: true }
const team = { id: 'team-a', key: 'ENG', name: 'Archived team', updatedAt, archivedAt: updatedAt, custom: true }
const relation = { id: 'relation-a', type: 'blocks', updatedAt: '2020-01-01T00:00:00Z', issue: { id: 'issue-a' }, relatedIssue: { id: 'issue-b' }, custom: true }
const history = { id: 'history-a', updatedAt: '2020-01-01T00:00:00Z', issue: { id: 'issue-a' }, actorId: 'user-a', fromTitle: 'Before', toTitle: 'After', custom: true }
const expectedRows = {
  issues: { ...issue, labels: ['Bug', 'Customer'] }, comments: comment, projects: project, project_updates: projectUpdate,
  cycles: cycle, users: user, teams: team, issue_relations: relation, issue_history: history,
}

interface GraphqlRequest { query: string; variables: Record<string, unknown> }
type Responder = (body: GraphqlRequest) => Response | Promise<Response>
type Pipeline = ReturnType<typeof createLinearPipeline>

test('Linear exposes nine independently selectable raw resource tables with provider join identities', async () => {
  const requests: GraphqlRequest[] = []
  const pipeline = fixturePipeline((body) => { requests.push(body); return fixtureResponse(body) })
  expect(linearPipeline.streams).toHaveLength(9)
  expect(pipeline.streams.map((stream) => stream.id).sort()).toEqual(resources.map((resource) => `linear.${resource}`).sort())
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const result = await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  expect(destination.tables.size).toBe(9)
  for (const [resource, raw] of Object.entries(expectedRows)) {
    expect(destination.tables.get(`default.linear_${resource}_raw`)?.map(({ id, raw }) => ({ id, raw }))).toEqual([{ id: raw.id, raw }])
  }
  for (const body of requests) expect(body.query).toContain('includeArchived: true')
  expect(requests.find((body) => operation(body) === 'Users')?.query).toContain('includeDisabled: true')
  expect(requests.find((body) => operation(body) === 'Comments')?.query).toContain('issueId projectUpdateId')
  expect(requests.find((body) => operation(body) === 'IssueHistory')?.query).toContain('actorId')
  const bounded = requests.filter((body) => body.variables.from !== undefined)
  expect(bounded).toHaveLength(7)
  for (const body of bounded) {
    expect(body.query).toContain('updatedAt: { gte: $from, lte: $to }')
    expect(body.query).toContain('orderBy: updatedAt')
    expect(body.variables).toEqual({ after: null, from: '1970-01-01T00:00:00.000Z', to: cutoff.toISOString() })
  }
  for (const resource of timestampResources) {
    expect((await journal.readCheckpoint(`linear.${resource}`)).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
  }
  for (const resource of ['issue_relations', 'issue_history']) {
    expect((await journal.readCheckpoint(`linear.${resource}`)).envelope).toBeUndefined()
    expect((await journal.readCheckpoint(`linear.${resource}`)).lastSuccessSeq).toBeGreaterThan(0)
  }
})

test('each resource runs alone and reversing stream order preserves the same observations', async () => {
  const pipeline = fixturePipeline(), combined = createMemoryDestination()
  expect((await runIngestion(request({ ...pipeline, streams: [...pipeline.streams].reverse() }),
    { journal: createMemoryJournal(), destination: combined, now: () => cutoff })).ok).toBe(true)
  for (const resource of resources) {
    const destination = createMemoryDestination(), calls: string[] = []
    const isolated = fixturePipeline((body) => { calls.push(operation(body)); return fixtureResponse(body) })
    const selected = request(isolated, resource)
    expect(selected.selected.map((entry) => entry.stream.id)).toEqual([`linear.${resource}`])
    expect((await runIngestion(selected, { journal: createMemoryJournal(), destination, now: () => cutoff })).ok).toBe(true)
    expect(destination.tables.size).toBe(1)
    expect(destination.tables.get(`default.linear_${resource}_raw`)?.map(({ id, raw }) => ({ id, raw })))
      .toEqual(combined.tables.get(`default.linear_${resource}_raw`)?.map(({ id, raw }) => ({ id, raw })))
    expect(calls).toHaveLength(resource === 'issue_history' ? 2 : 1)
  }
})

test('Linear page adapters preserve continuations and empty terminal pages', async () => {
  const signal = new AbortController().signal
  const context: FetchContext = { signal, attempt: (operation) => operation(signal) }
  const pages: Page<LinearObject, string>[] = []
  const afters: unknown[] = []
  for await (const page of readLinearPages(context, {
    query: 'query Comments($after: String) { comments(first: 100, after: $after) { nodes { id updatedAt } pageInfo { hasNextPage endCursor } } }',
    select: (data) => data.comments, label: 'comments', window: { from: new Date(0), to: cutoff },
  }, {
    token: () => 'fixture', fetch: async (_url, init) => {
      const body: GraphqlRequest = JSON.parse(String(init.body))
      afters.push(body.variables.after)
      return response('comments', body.variables.after === 'next' ? [comment] : [],
        body.variables.after === null ? 'next' : body.variables.after === 'next' ? 'terminal' : null)
    },
  })) pages.push(page)
  expect(afters).toEqual([null, 'next', 'terminal'])
  expect(pages.map((page) => page.items)).toEqual([[], [comment], []])
  expect(pages.map((page) => page.next)).toEqual(['next', 'terminal', undefined])
})

test('comment-only edits use their own update window without discovering or depending on old issues', async () => {
  let edited = false
  const requests: GraphqlRequest[] = []
  const oldIssue = { ...issue, updatedAt: '2020-01-01T00:00:00Z' }
  const pipeline = fixturePipeline((body) => {
    requests.push(body)
    if (operation(body) === 'Issues') return response('issues', edited ? [] : [oldIssue])
    if (operation(body) === 'Comments') return response('comments', [{ ...comment,
      body: edited ? 'Edited discussion on an old issue' : 'Original discussion', updatedAt: edited ? '2026-01-02T12:00:00Z' : updatedAt }])
    throw new IngestConfigError(`Unexpected request: ${operation(body)}`)
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const initial = { ...request(pipeline), selected: request(pipeline).selected.filter((entry) => ['linear.issues', 'linear.comments'].includes(entry.stream.id)) }
  expect((await runIngestion(initial, { journal, destination, now: () => cutoff })).ok).toBe(true)
  requests.length = 0
  edited = true
  expect((await runIngestion(request(pipeline, 'comments'), { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
  expect(requests.map(operation)).toEqual(['Comments'])
  expect(requests[0]?.variables).toEqual({ after: null, from: '2026-01-01T23:55:00.000Z', to: '2026-01-03T00:00:00.000Z' })
  expect((await journal.readCheckpoint('linear.issues')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
  expect((await journal.readCheckpoint('linear.comments')).envelope?.state).toEqual({ watermark: '2026-01-03T00:00:00.000Z' })
  const rows = destination.tables.get('default.linear_comments_raw') ?? []
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map((row) => row.id)).size).toBe(1)
  expect(rows.at(-1)?.raw).toEqual({ ...comment, body: 'Edited discussion on an old issue', updatedAt: '2026-01-02T12:00:00Z' })
  requests.length = 0
  expect((await runIngestion(request(pipeline, 'issues'), { journal, destination, now: () => new Date('2026-01-04') })).ok).toBe(true)
  expect(requests.map(operation)).toEqual(['Issues'])
  expect(requests[0]?.variables.from).toBe('2026-01-01T23:55:00.000Z')
  expect((await journal.readCheckpoint('linear.comments')).envelope?.state).toEqual({ watermark: '2026-01-03T00:00:00.000Z' })
})

test('issue labels are complete string arrays across nested pages while issue pages remain independent', async () => {
  const requests: GraphqlRequest[] = []
  const nextIssue = { ...issue, id: 'issue-b', labels: connection([]) }
  const pipeline = fixturePipeline((body) => {
    requests.push(body)
    if (operation(body) === 'IssueLabels') return Response.json({ data: { issue: { labels: connection(
      body.variables.after === 'labels-next' ? [{ id: 'label-b', name: 'Customer' }] : [{ id: 'label-c', name: 'Urgent' }],
      body.variables.after === 'labels-next' ? 'labels-last' : null) } } })
    if (body.variables.after) return response('issues', [nextIssue])
    return response('issues', [{ ...issue, labels: connection([{ id: 'label-a', name: 'Bug' }], 'labels-next') }], 'issues-next')
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'issues'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(requests.map(operation)).toEqual(['Issues', 'IssueLabels', 'IssueLabels', 'Issues'])
  expect(requests.filter((body) => operation(body) === 'IssueLabels').map((body) => body.variables)).toEqual([
    { id: 'issue-a', after: 'labels-next' }, { id: 'issue-a', after: 'labels-last' },
  ])
  expect(requests.every((body) => !body.query.includes('comments('))).toBe(true)
  expect(destination.tables.get('default.linear_issues_raw')?.map((row) => row.raw)).toEqual([
    { ...issue, labels: ['Bug', 'Customer', 'Urgent'] }, { ...nextIssue, labels: [] },
  ])
  expect((await journal.readCheckpoint('linear.issues')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
})

test('a labels page failure leaves the issue window uncommitted and replays from its first page', async () => {
  let fail = true
  const starts: unknown[] = []
  const pipeline = fixturePipeline((body) => {
    if (operation(body) === 'IssueLabels') return fail ? Response.json({ errors: [{ message: 'denied' }] })
      : Response.json({ data: { issue: { labels: connection([{ id: 'label-b', name: 'Customer' }]) } } })
    starts.push(body.variables.after)
    return response('issues', [{ ...issue, labels: connection([{ id: 'label-a', name: 'Bug' }], 'labels-next') }])
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination(), selected = request(pipeline, 'issues')
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('linear.issues')).envelope).toBeUndefined()
  expect(destination.tables.size).toBe(0)
  fail = false
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(starts).toEqual([null, null])
  expect(destination.tables.get('default.linear_issues_raw')?.[0]?.raw).toEqual(expectedRows.issues)
})

test('a failed comment page does not block any other resource and the next run replays its own window', async () => {
  let fail = true
  const starts: unknown[] = []
  const second = { ...comment, id: 'comment-b' }
  const pipeline = fixturePipeline((body) => {
    if (operation(body) !== 'Comments') return fixtureResponse(body)
    if (body.variables.after) return fail ? new Response('denied', { status: 403 }) : response('comments', [second])
    starts.push(body.variables.after)
    return response('comments', [comment], 'comments-next')
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const failed = await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })
  expect(failed.ok).toBe(false)
  expect(failed.streams.filter((stream) => stream.outcome === 'failed').map((stream) => stream.streamId)).toEqual(['linear.comments'])
  expect((await journal.readCheckpoint('linear.comments')).envelope).toBeUndefined()
  for (const resource of resources.filter((resource) => resource !== 'comments')) {
    expect((await journal.readCheckpoint(`linear.${resource}`)).lastSuccessSeq).toBeGreaterThan(0)
  }
  fail = false
  expect((await runIngestion(request(pipeline, 'comments'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(starts).toEqual([null, null])
  expect(destination.tables.get('default.linear_comments_raw')?.map((row) => row.id)).toEqual(['comment-a', 'comment-b'])
  expect((await journal.readCheckpoint('linear.comments')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
})

test('rejected comment writes preserve their prior watermark and replay the unacknowledged update window', async () => {
  const starts: unknown[] = []
  const pipeline = fixturePipeline((body) => {
    starts.push(body.variables.from)
    return response('comments', [{ ...comment, updatedAt: body.variables.from === '1970-01-01T00:00:00.000Z' ? updatedAt : '2026-01-02T12:00:00Z' }])
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination(), selected = request(pipeline, 'comments')
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
  const now = () => new Date('2026-01-03')
  expect((await runIngestion(selected, { journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } }, now })).ok).toBe(false)
  expect((await journal.readCheckpoint('linear.comments')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
  expect((await runIngestion(selected, { journal, destination, now })).ok).toBe(true)
  expect(starts).toEqual(['1970-01-01T00:00:00.000Z', '2026-01-01T23:55:00.000Z', '2026-01-01T23:55:00.000Z'])
  expect((await journal.readCheckpoint('linear.comments')).envelope?.state).toEqual({ watermark: now().toISOString() })
})

test('empty resources complete independently and timestamp windows overlap while full resources enumerate again', async () => {
  const requests: GraphqlRequest[] = []
  const pipeline = fixturePipeline((body) => { requests.push(body); return emptyResponse(body) })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  for (const now of [cutoff, new Date('2026-01-03')]) {
    expect((await runIngestion(request(pipeline), { journal, destination, now: () => now })).ok).toBe(true)
  }
  expect(destination.tables.size).toBe(0)
  for (const resource of timestampResources) {
    expect((await journal.readCheckpoint(`linear.${resource}`)).envelope?.state).toEqual({ watermark: '2026-01-03T00:00:00.000Z' })
  }
  const incremental = requests.filter((body) => body.variables.from !== undefined)
  expect(incremental).toHaveLength(14)
  expect(incremental.slice(0, 7).every((body) => body.variables.from === '1970-01-01T00:00:00.000Z')).toBe(true)
  expect(incremental.slice(7).every((body) => body.variables.from === '2026-01-01T23:55:00.000Z')).toBe(true)
  for (const name of ['IssueRelations', 'IssueHistoryParents']) {
    const full = requests.filter((body) => operation(body) === name)
    expect(full).toHaveLength(2)
    expect(full.every((body) => !body.query.includes('filter:') && body.variables.from === undefined)).toBe(true)
  }
  for (const resource of ['issue_relations', 'issue_history']) {
    expect((await journal.readCheckpoint(`linear.${resource}`)).envelope).toBeUndefined()
    expect(journal.events.filter((event) => event.namespaceId === `linear.${resource}` && event.eventKind === 'work_finished' && event.workState === 'succeeded')).toHaveLength(2)
  }
})

test('history enumerates all old and archived issues independently and retains paginated history join identities', async () => {
  const requests: GraphqlRequest[] = []
  const second = { ...history, id: 'history-b', toTitle: 'Later' }
  const third = { ...history, id: 'history-c', issue: { id: 'issue-b' } }
  const pipeline = fixturePipeline((body) => {
    requests.push(body)
    if (operation(body) === 'IssueHistoryParents') return response('issues', [{ id: body.variables.after ? 'issue-b' : 'issue-a',
      updatedAt: '2020-01-01T00:00:00Z', archivedAt: '2020-01-02T00:00:00Z' }], body.variables.after ? null : 'parents-next')
    return Response.json({ data: { issue: { history: connection(body.variables.id === 'issue-b' ? [third] : body.variables.after ? [second] : [history],
      body.variables.id === 'issue-a' && !body.variables.after ? 'history-next' : null) } } })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'issue_history'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(requests.map(operation)).toEqual(['IssueHistoryParents', 'IssueHistory', 'IssueHistory', 'IssueHistoryParents', 'IssueHistory'])
  expect(requests.every((body) => body.variables.from === undefined && !body.query.includes('filter:'))).toBe(true)
  expect(destination.tables.get('default.linear_issue_history_raw')?.map(({ id, raw }) => ({ id, raw }))).toEqual([history, second, third].map((raw) => ({ id: raw.id, raw })))
  expect((await journal.readCheckpoint('linear.issues')).lastSuccessSeq).toBe(0)
  expect((await journal.readCheckpoint('linear.issue_history')).envelope).toBeUndefined()
})

test('mutable relation full sync replays its first page after source and sink failures and refreshes old records', async () => {
  let fail = true, changed = false
  const starts: unknown[] = []
  const second = { ...relation, id: 'relation-b' }
  const pipeline = fixturePipeline((body) => {
    expect(operation(body)).toBe('IssueRelations')
    expect(body.variables.from).toBeUndefined()
    expect(body.query).not.toContain('filter:')
    if (body.variables.after) return fail ? new Response('denied', { status: 403 }) : response('issueRelations', [second])
    starts.push(body.variables.after)
    return response('issueRelations', [{ ...relation, type: changed ? 'duplicate' : relation.type }], 'relations-next')
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination(), selected = request(pipeline, 'issue_relations')
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('linear.issue_relations')).lastSuccessSeq).toBe(0)
  fail = false
  expect((await runIngestion(selected, { journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } }, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('linear.issue_relations')).lastSuccessSeq).toBe(0)
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
  changed = true
  expect((await runIngestion(selected, { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
  expect(starts).toEqual([null, null, null, null])
  expect((await journal.readCheckpoint('linear.issue_relations')).envelope).toBeUndefined()
  const rows = destination.tables.get('default.linear_issue_relations_raw') ?? []
  expect(rows.filter((row) => row.id === relation.id).map((row) => row.raw)).toEqual([relation, { ...relation, type: 'duplicate' }])
})

test('history failures replay all parent discovery without recording completion before every history write succeeds', async () => {
  let fail = true
  const starts: unknown[] = []
  const second = { ...history, id: 'history-b', issue: { id: 'issue-b' } }
  const pipeline = fixturePipeline((body) => {
    if (operation(body) === 'IssueHistoryParents') {
      starts.push(body.variables.after)
      return response('issues', [{ id: 'issue-a' }, { id: 'issue-b' }])
    }
    if (body.variables.id === 'issue-b' && fail) return new Response('denied', { status: 403 })
    return Response.json({ data: { issue: { history: connection(body.variables.id === 'issue-a' ? [history] : [second]) } } })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination(), selected = request(pipeline, 'issue_history')
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('linear.issue_history')).lastSuccessSeq).toBe(0)
  expect((await journal.readCheckpoint('linear.issue_history')).envelope).toBeUndefined()
  fail = false
  expect((await runIngestion(selected, { journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } }, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('linear.issue_history')).lastSuccessSeq).toBe(0)
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(starts).toEqual([null, null, null])
  expect((await journal.readCheckpoint('linear.issue_history')).envelope).toBeUndefined()
  expect((await journal.readCheckpoint('linear.issue_history')).lastSuccessSeq).toBeGreaterThan(0)
  expect(destination.tables.get('default.linear_issue_history_raw')?.map(({ id, raw }) => ({ id, raw }))).toEqual([history, second].map((raw) => ({ id: raw.id, raw })))
  expect((await journal.readCheckpoint('linear.issues')).lastSuccessSeq).toBe(0)
})

test('Linear binds custom date selection and isolates each installation and resource checkpoint', async () => {
  const requests: GraphqlRequest[] = []
  const config = { ...linearConfig, sourceId: 'linear.fixture', start: new Date('2025-01-01'), overlapMs: 60_000 }
  const pipeline = createLinearPipeline(config, { token: () => 'bound-token', fetch: async (_url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('bound-token')
    const body: GraphqlRequest = JSON.parse(String(init.body))
    requests.push(body)
    return emptyResponse(body)
  } })
  config.start.setUTCFullYear(2000)
  config.overlapMs = 3_600_000
  config.sourceId = 'mutated'
  expect(pipeline.streams.map((stream) => stream.id).sort()).toEqual(resources.map((resource) => `linear.fixture.${resource}`).sort())
  const failing = createLinearPipeline({ ...linearConfig, sourceId: 'linear.denied' }, { token: () => 'denied', fetch: async () => new Response('denied', { status: 403 }) })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const selected = selectStreams([failing, pipeline], ['resource:comments']).map((entry) => ({ ...entry, stream: { ...entry.stream, retry: { retries: 0 } } }))
  const result = await runIngestion({ selected, backfill: undefined }, { journal, destination, now: () => cutoff })
  expect(result.streams.map((stream) => stream.outcome)).toEqual(['failed', 'succeeded'])
  expect(requests[0]?.variables).toEqual({ after: null, from: '2025-01-01T00:00:00.000Z', to: cutoff.toISOString() })
  expect((await journal.readCheckpoint('linear.denied.comments')).envelope).toBeUndefined()
  expect((await journal.readCheckpoint('linear.fixture.comments')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
  const onlyFixture = selectStreams([failing, pipeline], ['stream:linear.fixture.comments'])
  expect(onlyFixture.map((entry) => entry.stream.id)).toEqual(['linear.fixture.comments'])
  expect((await runIngestion({ selected: onlyFixture, backfill: undefined }, { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
  expect(requests[1]?.variables.from).toBe('2026-01-01T23:59:00.000Z')
  expect((await journal.readCheckpoint('linear.fixture.issues')).envelope).toBeUndefined()
  expect((await journal.readCheckpoint('linear.comments')).envelope).toBeUndefined()
})

test('nullable provider comment references retain the comment ID and unmodified raw payload', async () => {
  const detached = { ...comment, issueId: null, projectUpdateId: 'project-update-a', user: null }
  const pipeline = fixturePipeline(() => response('comments', [detached]))
  const destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'comments'), { journal: createMemoryJournal(), destination, now: () => cutoff })).ok).toBe(true)
  expect(destination.tables.get('default.linear_comments_raw')?.map(({ id, raw }) => ({ id, raw }))).toEqual([{ id: detached.id, raw: detached }])
})

test('GraphQL HTTP400 and HTTP200 rate exhaustion each consume exactly one page retry', async () => {
  for (const status of [400, 200]) {
    let attempts = 0
    const pipeline = fixturePipeline(() => ++attempts === 1
      ? Response.json({ errors: [{ message: 'rate limit', extensions: { code: 'RATELIMITED' } }] }, { status, headers: { 'Retry-After': '0' } })
      : response('comments', []))
    const selected = request(pipeline, 'comments').selected.map((entry) => ({ ...entry, stream: { ...entry.stream, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 } } }))
    const journal = createMemoryJournal()
    expect((await runIngestion({ selected, backfill: undefined }, { journal, destination: createMemoryDestination(), now: () => cutoff })).ok).toBe(true)
    expect(attempts).toBe(2)
    expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toHaveLength(1)
  }
})

test('partial GraphQL data with errors cannot write rows, retry, or complete a resource', async () => {
  for (const resource of ['comments', 'issue_relations', 'issue_history']) {
    let attempts = 0
    const pipeline = fixturePipeline((body) => {
      attempts++
      return Response.json({ data: operation(body) === 'IssueHistoryParents' ? { issues: connection([{ id: issue.id }]) }
        : operation(body) === 'Comments' ? { comments: connection([comment]) } : { issueRelations: connection([relation]) },
      errors: [{ message: 'Some fields were denied', extensions: { code: 'FORBIDDEN' } }] })
    })
    const selected = request(pipeline, resource).selected.map((entry) => ({ ...entry, stream: { ...entry.stream, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 } } }))
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    expect((await runIngestion({ selected, backfill: undefined }, { journal, destination, now: () => cutoff })).ok).toBe(false)
    expect(attempts).toBe(1)
    expect(destination.tables.size).toBe(0)
    expect((await journal.readCheckpoint(`linear.${resource}`)).lastSuccessSeq).toBe(0)
    expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled')).toHaveLength(0)
  }
})

test('malformed root and nested continuations fail before another request or successful checkpoint', async () => {
  for (const name of ['Comments', 'IssueRelations', 'IssueLabels', 'IssueHistoryParents', 'IssueHistory']) {
    for (const endCursor of [7, ' ', null]) {
      let attempts = 0
      const pipeline = fixturePipeline((body) => {
        if (operation(body) !== name) return precedingResponse(body, name)
        attempts++
        return connectionFor(body, { nodes: [], pageInfo: { hasNextPage: true, endCursor } })
      })
      const resource = resourceFor(name), journal = createMemoryJournal()
      const result = await runIngestion(request(pipeline, resource), { journal, destination: createMemoryDestination(), now: () => cutoff })
      expect(result.ok, `${name}:${String(endCursor)}`).toBe(false)
      expect(attempts).toBe(1)
      expect((await journal.readCheckpoint(`linear.${resource}`)).envelope).toBeUndefined()
      expect((await journal.readCheckpoint(`linear.${resource}`)).lastSuccessSeq).toBe(0)
    }
  }
})

test('cyclic root and nested pagination fails permanently without replaying a whole reader', async () => {
  for (const name of ['Comments', 'IssueRelations', 'IssueLabels', 'IssueHistoryParents', 'IssueHistory']) {
    const afters: unknown[] = []
    const pipeline = fixturePipeline((body) => {
      if (operation(body) !== name) return precedingResponse(body, name)
      afters.push(body.variables.after)
      return connectionFor(body, connection([], body.variables.after === 'a' ? 'b' : 'a'))
    })
    const resource = resourceFor(name), journal = createMemoryJournal()
    const selected = request(pipeline, resource).selected.map((entry) => ({ ...entry, stream: { ...entry.stream, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 } } }))
    const result = await runIngestion({ selected, backfill: undefined }, { journal, destination: createMemoryDestination(), now: () => cutoff })
    expect(result.ok, name).toBe(false)
    expect(afters).toEqual(name === 'IssueLabels' ? ['a', 'b'] : [null, 'a', 'b'])
    expect((await journal.readCheckpoint(`linear.${resource}`)).lastSuccessSeq).toBe(0)
    expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled')).toHaveLength(0)
  }
})

test('malformed connections or provider identities cannot silently complete an empty-looking window', async () => {
  for (const payload of [
    { nodes: {}, pageInfo: { hasNextPage: false, endCursor: null } },
    { nodes: [], pageInfo: { hasNextPage: 'false', endCursor: null } },
    connection([{ ...comment, id: '' }]), connection([{ ...comment, updatedAt: 'invalid' }]),
    connection([{ ...comment, updatedAt: '2026-01-03T00:00:00Z' }]),
  ]) {
    let attempts = 0
    const pipeline = fixturePipeline(() => { attempts++; return Response.json({ data: { comments: payload } }) })
    const journal = createMemoryJournal()
    expect((await runIngestion(request(pipeline, 'comments'), { journal, destination: createMemoryDestination(), now: () => cutoff })).ok).toBe(false)
    expect(attempts).toBe(1)
    expect((await journal.readCheckpoint('linear.comments')).envelope).toBeUndefined()
  }
})

function fixturePipeline(respond: Responder = fixtureResponse, config: LinearConfig = linearConfig): Pipeline {
  return createLinearPipeline(config, { token: () => 'fixture', fetch: async (_url, init) => respond(JSON.parse(String(init.body))) })
}

function request(pipeline: Pipeline, resource?: string) {
  return { selected: selectStreams([pipeline], resource ? [`resource:${resource}`] : []).map((entry) => ({
    ...entry, stream: { ...entry.stream, batchSize: 1, retry: { retries: 0 } },
  })), backfill: undefined }
}

function operation(body: GraphqlRequest): string {
  const name = /query\s+(\w+)/.exec(body.query)?.[1]
  if (!name) throw new IngestConfigError('Fixture received an unnamed GraphQL operation.')
  return name
}

function fixtureResponse(body: GraphqlRequest): Response {
  switch (operation(body)) {
    case 'Issues': return response('issues', [issue])
    case 'Comments': return response('comments', [comment])
    case 'Projects': return response('projects', [project])
    case 'ProjectUpdates': return response('projectUpdates', [projectUpdate])
    case 'Cycles': return response('cycles', [cycle])
    case 'Users': return response('users', [user])
    case 'Teams': return response('teams', [team])
    case 'IssueRelations': return response('issueRelations', [relation])
    case 'IssueHistoryParents': return response('issues', [{ id: issue.id, updatedAt: '2020-01-01T00:00:00Z' }])
    case 'IssueHistory': return Response.json({ data: { issue: { history: connection([history]) } } })
    default: throw new IngestConfigError(`Unexpected Linear fixture operation: ${operation(body)}`)
  }
}

function connection(items: readonly unknown[], next: string | null = null) {
  return { nodes: items, pageInfo: { hasNextPage: next !== null, endCursor: next } }
}

function response(root: string, items: readonly unknown[], next: string | null = null): Response {
  return Response.json({ data: { [root]: connection(items, next) } })
}

function emptyResponse(body: GraphqlRequest): Response {
  return connectionFor(body, connection([]))
}

function connectionFor(body: GraphqlRequest, page: unknown): Response {
  const roots: Record<string, string> = { Issues: 'issues', Comments: 'comments', Projects: 'projects', ProjectUpdates: 'projectUpdates',
    Cycles: 'cycles', Users: 'users', Teams: 'teams', IssueRelations: 'issueRelations', IssueHistoryParents: 'issues' }
  const root = roots[operation(body)]
  if (root) return Response.json({ data: { [root]: page } })
  if (operation(body) === 'IssueLabels') return Response.json({ data: { issue: { labels: page } } })
  if (operation(body) === 'IssueHistory') return Response.json({ data: { issue: { history: page } } })
  throw new IngestConfigError(`Unexpected Linear fixture operation: ${operation(body)}`)
}

function resourceFor(name: string): string {
  return name === 'Comments' ? 'comments' : name === 'IssueRelations' ? 'issue_relations' : name === 'IssueLabels' ? 'issues' : 'issue_history'
}

function precedingResponse(body: GraphqlRequest, target: string): Response {
  if (target === 'IssueLabels') return response('issues', [{ ...issue, labels: connection([], 'a') }])
  return fixtureResponse(body)
}
