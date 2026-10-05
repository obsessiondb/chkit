import { afterEach, describe, expect, test } from 'bun:test'

import { HttpError, definePipeline, defineStream, runIngestion, selectStreams, type FetchContext, type ReadContext, type SourceChunk } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { classifySlackError, discoverChannels, readCollection, type SlackClientDeps } from '../client.js'
import { slackConfig } from '../config.js'
import * as definitions from '../index.js'
import { createSlackPipeline, slack } from '../pipeline.js'
import { readChannels } from '../sources/channels.js'
import { readUsers } from '../sources/users.js'
import { readMessages } from '../sources/messages.js'
import { messageScope, parseMessageState, slackMessageStrategy, type SlackMessageSelection, type SlackMessageState } from '../state.js'
import { channel, fixtureDeps, parentMessage, replyMessage, standaloneMessage, user } from './fixtures.js'

const readers: Record<string, (context: FetchContext, deps: SlackClientDeps) => AsyncIterable<SourceChunk>> = {
  channels: readChannels, users: readUsers,
}
const originalConfig = { ...slackConfig }
const fixtureNow = () => new Date('2023-11-15T00:00:00Z')

afterEach(() => { Object.assign(slackConfig, originalConfig) })

describe('Slack raw template', () => {
  test('exports three raw destinations and checkpointed messages without credentials', () => {
    const exported = Object.values(definitions)
    expect(exported).toContain(slack)
    expect(slack.streams).toHaveLength(3)
    expect(slack.streams.map((stream) => stream.destination.name)).toEqual(['slack_channels_raw', 'slack_users_raw', 'slack_messages_raw'])
    for (const stream of slack.streams) {
      expect(exported).toContain(stream.destination)
      expect(stream.incremental.id).toBe(stream.id.endsWith('.messages') ? 'slack.message-ranges' : 'chkit.full_sync')
    }
    expect(selectStreams([slack], ['provider:slack', 'resource:messages']).map(({ stream }) => stream.id)).toEqual(['slack.primary.messages'])
  })

  test('a pipeline binds installation identity and reader settings independently of later config edits', async () => {
    const config = { ...slackConfig, sourceId: 'slack.secondary', channels: ['C1'], conversationTypes: ['public_channel'] as const,
      includeReplies: false, pageSize: 37, messagePageSize: 12, requestIntervalMs: 7, messageIntervalMs: 11, historyFrom: '1699999999.000000' }
    const expectedScope = messageScope('T1', config)
    const requests: URL[] = [], waits: number[] = []
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => { requests.push(url); return defaults.fetch(url.toString(), init) })
    deps.wait = async (milliseconds) => { waits.push(milliseconds) }
    const pipeline = createSlackPipeline(config, deps)
    config.sourceId = 'changed'
    config.channels.push('missing')
    config.historyFrom = 'invalid'
    slackConfig.sourceId = 'unrelated'
    slackConfig.includeReplies = true
    slackConfig.historyFrom = 'invalid'
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { now: fixtureNow, journal, destination })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.streams.map((stream) => stream.streamId)).toEqual(['slack.secondary.channels', 'slack.secondary.users', 'slack.secondary.messages'])
    expect(parseMessageState((await journal.readCheckpoint('slack.secondary.messages')).envelope?.state).scope).toBe(expectedScope)
    expect(destination.tables.get('default.slack_messages_raw')?.[0]?.id).toBe(JSON.stringify(['slack.secondary', 'messages', 'T1', 'C1', parentMessage.ts]))
    expect(destination.tables.get('default.slack_users_raw')?.[0]?.raw).toMatchObject({ source_id: 'slack.secondary' })
    expect(requests.filter((url) => url.pathname === '/api/conversations.list' || url.pathname === '/api/users.list').every((url) => url.searchParams.get('limit') === '37')).toBe(true)
    expect(requests.find((url) => url.pathname === '/api/conversations.history')?.searchParams.get('limit')).toBe('12')
    expect(requests.find((url) => url.pathname === '/api/conversations.history')?.searchParams.get('oldest')).toBe('1699999998.999999')
    expect(requests.some((url) => url.pathname === '/api/conversations.replies')).toBe(false)
    expect(waits).toContain(7)
    expect(waits).toContain(11)
  })

  test('a failed resource leaves the other resource streams selectable and able to commit', async () => {
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => url.pathname === '/api/users.list'
      ? Response.json({ ok: false, error: 'missing_scope', needed: 'users:read' }) : defaults.fetch(url.toString(), init))
    const pipeline = createSlackPipeline(slackConfig, deps)
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { now: fixtureNow, journal, destination })
    expect(result.ok).toBe(false)
    expect(result.streams.map((stream) => stream.outcome)).toEqual(['succeeded', 'failed', 'succeeded'])
    expect(destination.tables.has('default.slack_channels_raw')).toBe(true)
    expect(destination.tables.has('default.slack_users_raw')).toBe(false)
    expect(destination.tables.has('default.slack_messages_raw')).toBe(true)
    expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state).active).toBeUndefined()
    expect((await journal.readCheckpoint('slack.primary.users')).envelope).toBeUndefined()
    expect(selectStreams([pipeline], ['resource:users']).map(({ stream }) => stream.id)).toEqual(['slack.primary.users'])
  })

  test('every stream preserves provider payloads and reruns publish edits under stable identities', async () => {
    let changed = false
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => url.pathname === '/api/conversations.history' && changed
      ? Response.json({ ok: true, messages: [{ ...parentMessage, text: 'Edited discussion' }, standaloneMessage], response_metadata: { next_cursor: '' } })
      : defaults.fetch(url.toString(), init))
    const pipeline = fixturePipeline(deps)
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const request = { selected: selectStreams([pipeline], []), backfill: undefined }
    const first = await runIngestion(request, { now: fixtureNow, journal, destination })
    expect(first.ok, JSON.stringify(first)).toBe(true)
    expect(first.streams.map((stream) => stream.rows)).toEqual([1, 2, 4])
    expect(destination.tables.size).toBe(3)
    expect(destination.tables.get('default.slack_users_raw')?.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', data: user })
    const messages = destination.tables.get('default.slack_messages_raw') ?? []
    expect(messages.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: parentMessage })
    expect(messages.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: replyMessage })
    expect(new Set(messages.map((row) => row.id)).size).toBe(3)
    expect(messages.find((row) => JSON.stringify(row.raw).includes('Edited discussion'))).toBeUndefined()
    changed = true
    const second = await runIngestion(request, { now: fixtureNow, journal, destination })
    expect(second.ok, JSON.stringify(second)).toBe(true)
    const repeated = destination.tables.get('default.slack_messages_raw') ?? []
    const edited = repeated.find((row) => JSON.stringify(row.raw).includes('Edited discussion'))
    expect(edited?.id).toBe(JSON.stringify(['slack.primary', 'messages', 'T1', 'C1', parentMessage.ts]))
    expect(new Set(repeated.map((row) => row.id)).size).toBe(3)
  })

  test('cursor pagination continues across an empty page and includes all later entities', async () => {
    const cursors: Array<string | null> = []
    const deps = fixtureDeps((url) => {
      const cursor = url.searchParams.get('cursor')
      cursors.push(cursor)
      if (cursor === null) return Response.json({ ok: true, channels: [], response_metadata: { next_cursor: 'empty-next' } })
      if (cursor === 'empty-next') return Response.json({ ok: true, channels: [channel], response_metadata: { next_cursor: 'final-next' } })
      if (cursor === 'final-next') return Response.json({ ok: true, channels: [{ ...channel, id: 'C2' }], response_metadata: { next_cursor: null } })
      throw new Error(`Unexpected cursor ${cursor}`)
    })
    const pages = await collect(readCollection(context(), { method: 'conversations.list', field: 'channels', idField: 'id', pageSize: 2 }, deps))
    expect(pages.flat().map((value) => value.id)).toEqual(['C1', 'C2'])
    expect(cursors).toEqual([null, 'empty-next', 'final-next'])
  })

  test('the channels reader yields a page before fetching the next selected conversation page', async () => {
    let channelCalls = 0
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      if (url.pathname !== '/api/conversations.list') return defaults.fetch(url.toString(), init)
      channelCalls += 1
      return Response.json({ ok: true, channels: [{ ...channel, id: channelCalls === 1 ? 'C1' : 'C2' }],
        response_metadata: { next_cursor: channelCalls === 1 ? 'next' : '' } })
    })
    const iterator = readChannels(context(), deps)
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value?.rows[0]?.id).toBe(JSON.stringify(['slack.primary', 'channels', 'T1', 'C1']))
    expect(channelCalls).toBe(1)
    const second = await iterator.next()
    expect(second.done).toBe(false)
    expect(second.value?.rows[0]?.id).toBe(JSON.stringify(['slack.primary', 'channels', 'T1', 'C2']))
    expect(channelCalls).toBe(2)
    expect((await iterator.next()).done).toBe(true)
  })

  test('channel discovery reports missing configured IDs after yielding accessible pages', async () => {
    const deps = { ...fixtureDeps(), config: { ...slackConfig, channels: ['C1', 'missing'] } }
    const iterator = readChannels(context(), deps)
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value?.rows).toHaveLength(1)
    await expect(iterator.next()).rejects.toThrow('Configured Slack channel "missing" was not found')
  })

  test('messages discover channels independently and paginate threads including the parent payload', async () => {
    const requests: URL[] = []
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      requests.push(url)
      if (url.pathname === '/api/conversations.history') return Response.json({ ok: true, messages: [parentMessage], response_metadata: { next_cursor: '' } })
      if (url.pathname === '/api/conversations.replies') {
        expect(url.searchParams.get('channel')).toBe('C1')
        expect(url.searchParams.get('ts')).toBe(parentMessage.ts)
        return url.searchParams.has('cursor')
          ? Response.json({ ok: true, messages: [replyMessage], response_metadata: { next_cursor: '' } })
          : Response.json({ ok: true, messages: [{ ...parentMessage, text: 'Latest parent' }], response_metadata: { next_cursor: 'reply-next' } })
      }
      return defaults.fetch(url.toString(), init)
    })
    const chunks = await collect(readMessages(context(), deps))
    expect(chunks.flatMap((chunk) => chunk.rows).map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: { ...parentMessage, text: 'Latest parent' } })
    expect(chunks.flatMap((chunk) => chunk.rows)).toHaveLength(3)
    expect(chunks.every((chunk) => 'state' in chunk)).toBe(true)
    expect(chunks.filter((chunk) => chunk.rows.length > 0).every((chunk) => chunk.id === undefined)).toBe(true)
    const messageRequests = requests.filter((url) => ['conversations.history', 'conversations.replies'].some((method) => url.pathname.endsWith(method)))
    expect(messageRequests.map((url) => url.searchParams.get('limit'))).toEqual(['15', '15', '15'])
    expect(messageRequests.at(-1)?.searchParams.get('cursor')).toBe('reply-next')
    expect(requests.some((url) => url.pathname === '/api/conversations.list')).toBe(true)
  })

  test('row identities separate source installations, workspaces, and conversations', async () => {
    const defaults = fixtureDeps()
    const readForTeam = async (team: string) => collect(readMessages(context(), fixtureDeps((url, init) => {
      if (url.pathname === '/api/auth.test') return Response.json({ ok: true, team_id: team })
      if (url.pathname === '/api/conversations.list') return Response.json({ ok: true, channels: [channel, { ...channel, id: 'C2' }], response_metadata: { next_cursor: '' } })
      if (url.pathname === '/api/conversations.history') return Response.json({ ok: true, messages: [standaloneMessage], response_metadata: { next_cursor: '' } })
      return defaults.fetch(url.toString(), init)
    })))
    const first = (await readForTeam('T1')).flatMap((chunk) => chunk.rows)
    const second = (await readForTeam('T2')).flatMap((chunk) => chunk.rows)
    slackConfig.sourceId = 'slack.secondary'
    const separateSource = (await readForTeam('T1')).flatMap((chunk) => chunk.rows)
    expect(new Set([...first, ...second, ...separateSource].map((row) => row.id)).size).toBe(6)
    expect(first[0]?.id).toBe(JSON.stringify(['slack.primary', 'messages', 'T1', 'C1', standaloneMessage.ts]))
  })

  test('finishes retained thread work before resuming history from its timestamp frontier', async () => {
    const requests: string[] = []
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      if (url.pathname === '/api/conversations.history') {
        const latest = url.searchParams.get('latest')
        const resumed = latest === parentMessage.ts
        requests.push(`history:${resumed ? 'resumed' : 'first'}`)
        return Response.json({ ok: true, messages: [resumed ? { ...standaloneMessage, ts: '1699999999.000003' } : parentMessage], has_more: !resumed })
      }
      if (url.pathname === '/api/conversations.replies') {
        requests.push('replies')
        return Response.json({ ok: true, messages: [parentMessage, replyMessage], response_metadata: { next_cursor: null } })
      }
      return defaults.fetch(url.toString(), init)
    })
    const chunks = await collect(readMessages(context(), deps))
    expect(chunks.flatMap((chunk) => chunk.rows)).toHaveLength(4)
    expect(requests).toEqual(['history:first', 'replies', 'history:resumed'])
  })

  test('history-only selection avoids thread API requests', async () => {
    slackConfig.includeReplies = false
    const requests: string[] = []
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => { requests.push(url.pathname); return defaults.fetch(url.toString(), init) })
    const chunks = await collect(readMessages(context(), deps))
    expect(chunks.flatMap((chunk) => chunk.rows)).toHaveLength(2)
    expect(requests).not.toContain('/api/conversations.replies')
  })

  test('configured channel IDs narrow discovery and unknown IDs fail visibly', async () => {
    slackConfig.channels = ['C1']
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => url.pathname === '/api/conversations.list'
      ? Response.json({ ok: true, channels: [channel, { ...channel, id: 'C2' }], response_metadata: { next_cursor: '' } })
      : defaults.fetch(url.toString(), init))
    expect((await discoverChannels(context(), deps)).map((value) => value.id)).toEqual(['C1'])
    slackConfig.channels = ['missing']
    await expect(discoverChannels(context(), deps)).rejects.toThrow('missing')
    slackConfig.channels = []
    expect(await discoverChannels(context(), deps)).toEqual([])
  })

  test('cancellation stops before the second history page and preserves configured pacing', async () => {
    const controller = new AbortController()
    const requests: URL[] = []
    const waits: number[] = []
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      requests.push(url)
      return url.pathname === '/api/conversations.history'
        ? Response.json({ ok: true, messages: [standaloneMessage], response_metadata: { next_cursor: 'history-next' } })
        : defaults.fetch(url.toString(), init)
    })
    deps.wait = async (milliseconds, signal) => { waits.push(milliseconds); signal.throwIfAborted() }
    const iterator = readMessages(context(controller.signal), deps)
    const opening = await iterator.next()
    expect(opening.value?.rows).toHaveLength(0)
    const first = await iterator.next()
    expect(first.value?.rows).toHaveLength(1)
    controller.abort(new Error('fixture cancelled'))
    await expect(iterator.next()).rejects.toThrow('fixture cancelled')
    expect(requests.filter((url) => url.pathname === '/api/conversations.history')).toHaveLength(1)
    expect(waits).toContain(slackConfig.messageIntervalMs)
    expect(waits.filter((milliseconds) => milliseconds === slackConfig.requestIntervalMs).length).toBeGreaterThanOrEqual(1)
  })

  test('malformed successful responses fail instead of becoming empty datasets', async () => {
    for (const payload of [{}, { ok: true, members: null }, { ok: true, members: [{ name: 'missing-id' }] }]) {
      const defaults = fixtureDeps()
      const deps = fixtureDeps((url, init) => url.pathname === '/api/users.list' ? Response.json(payload) : defaults.fetch(url.toString(), init))
      await expect(collect(readUsers(context(), deps))).rejects.toThrow('Slack')
    }
  })

  test('malformed message timestamps and pagination fail rather than truncate a scan', async () => {
    const request = { method: 'conversations.history', field: 'messages', idField: 'ts' } as const
    for (const payload of [
      { ok: true, messages: [{ ...standaloneMessage, ts: 1_700_000_002.000003 }] },
      { ok: true, messages: [{ ...standaloneMessage, ts: 'invalid' }] },
      { ok: true, messages: [standaloneMessage], has_more: true },
      { ok: true, messages: [standaloneMessage], response_metadata: { next_cursor: 123 } },
    ]) {
      await expect(collect(readCollection(context(), request, fixtureDeps(() => Response.json(payload))))).rejects.toThrow('Slack')
    }
    let calls = 0
    const repeated = fixtureDeps(() => {
      calls += 1
      if (calls > 3) throw new Error('Repeated cursor was not rejected')
      return Response.json({ ok: true, messages: [standaloneMessage], response_metadata: { next_cursor: 'same-cursor' } })
    })
    await expect(collect(readCollection(context(), request, repeated))).rejects.toThrow('repeated')
    expect(calls).toBe(2)
  })

  test('HTTP 200 permission errors fail permanently without loading any rows', async () => {
    let calls = 0
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      if (url.pathname !== '/api/users.list') return defaults.fetch(url.toString(), init)
      calls += 1
      return Response.json({ ok: false, error: 'missing_scope', needed: 'users:read', provided: 'channels:read' })
    })
    const destination = createMemoryDestination()
    const result = await runFixture(deps, ['users'], destination)
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.error).toContain('missing_scope')
    expect(result.streams[0]?.error).toContain('users:read')
    expect(result.streams[0]?.rows).toBe(0)
    expect(calls).toBe(1)
    expect(destination.tables.size).toBe(0)
  })

  test('HTTP 200 transient errors retry inside the ingestion executor', async () => {
    let calls = 0
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      if (url.pathname !== '/api/users.list') return defaults.fetch(url.toString(), init)
      calls += 1
      return calls === 1 ? Response.json({ ok: false, error: 'internal_error' }) : Response.json({ ok: true, members: [user], response_metadata: { next_cursor: '' } })
    })
    const result = await runFixture(deps, ['users'])
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(calls).toBe(2)
  })

  test('metadata pagination has one executor retry budget per request', async () => {
    let calls = 0
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      if (url.pathname !== '/api/users.list') return defaults.fetch(url.toString(), init)
      calls += 1
      return Response.json({ ok: false, error: 'internal_error' })
    })
    const result = await runFixture(deps, ['users'])
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.outcome).toBe('failed')
    expect(calls).toBe(2)
  })

  test('HTTP 200 rate-limit errors retain Retry-After and retry under executor authority', async () => {
    let calls = 0
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      if (url.pathname !== '/api/users.list') return defaults.fetch(url.toString(), init)
      calls += 1
      return calls === 1
        ? Response.json({ ok: false, error: 'ratelimited' }, { headers: { 'Retry-After': '0' } })
        : Response.json({ ok: true, members: [user], response_metadata: { next_cursor: '' } })
    })
    const journal = createMemoryJournal()
    const pipeline = fixturePipeline(deps, ['users'])
    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { now: fixtureNow, journal, destination: createMemoryDestination() })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(calls).toBe(2)
    expect(journal.events.some((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toBe(true)
  })

  test('thread permission errors fail the stream and leave already loaded history visible', async () => {
    let replyCalls = 0
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      if (url.pathname !== '/api/conversations.replies') return defaults.fetch(url.toString(), init)
      replyCalls += 1
      return Response.json({ ok: false, error: 'missing_scope', needed: 'channels:history' })
    })
    const fixture = fixturePipeline(deps, ['messages'])
    const pipeline = definePipeline({ ...fixture, streams: fixture.streams.map((stream) => ({ ...stream, batchSize: 1 })) })
    const destination = createMemoryDestination()
    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { now: fixtureNow, journal: createMemoryJournal(), destination })
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.outcome).toBe('failed')
    expect(result.streams[0]?.error).toContain('missing_scope')
    expect(replyCalls).toBe(1)
    expect(destination.tables.get('default.slack_messages_raw')).toHaveLength(2)
    expect(destination.tables.get('default.slack_messages_raw')?.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: parentMessage })
  })

  test('429 errors preserve Retry-After and retry the current page', async () => {
    let calls = 0
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      if (url.pathname !== '/api/users.list') return defaults.fetch(url.toString(), init)
      calls += 1
      return calls === 1
        ? Response.json({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json({ ok: true, members: [user], response_metadata: { next_cursor: '' } })
    })
    const journal = createMemoryJournal()
    const pipeline = fixturePipeline(deps, ['users'])
    const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { now: fixtureNow, journal, destination: createMemoryDestination() })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(calls).toBe(2)
    expect(journal.events.some((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toBe(true)
    const http = await HttpError.fromResponse(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
    expect(http.retryAfterMs).toBe(2_000)
    expect(classifySlackError(http, { kind: 'rate_limited', retryAfterMs: 2_000 })).toBeUndefined()
  })

  test('missing credentials fail only when a reader runs', async () => {
    const deps = fixtureDeps(() => { throw new Error('must not fetch') })
    deps.token = () => undefined
    expect(slack.streams).toHaveLength(3)
    await expect(collect(readUsers(context(), deps))).rejects.toThrow('SLACK_API_TOKEN')
  })
})

function fixturePipeline(deps: SlackClientDeps, selectedResources?: readonly string[]) {
  return definePipeline({
    ...slack,
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0, randomize: false },
    streams: slack.streams.filter((stream) => selectedResources === undefined || selectedResources.includes(stream.id.split('.').at(-1) ?? '')).map((stream) => {
      if (stream.id.endsWith('.messages')) return defineStream({ ...stream, incremental: slackMessageStrategy, read: (context) => readMessages(context, deps) })
      const read = readers[stream.id.split('.').at(-1) ?? '']
      if (!read) throw new Error(`No fixture reader for ${stream.id}`)
      return { ...stream, read: (context: FetchContext) => read(context, deps) }
    }),
  })
}

async function runFixture(deps: SlackClientDeps, selectedResources: readonly string[], destination = createMemoryDestination()) {
  const pipeline = fixturePipeline(deps, selectedResources)
  return runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { now: fixtureNow, journal: createMemoryJournal(), destination })
}

function context(signal = new AbortController().signal): ReadContext<SlackMessageSelection, SlackMessageState> {
  return { signal, attempt: async (operation) => operation(signal), streamId: 'slack.primary.messages', state: undefined,
    cutoff: fixtureNow(), selection: slackMessageStrategy.plan({ cutoff: fixtureNow(), state: undefined, range: undefined }) }
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}
