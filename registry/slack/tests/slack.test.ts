import { describe, expect, test } from 'bun:test'

import { HttpError, definePipeline, runIngestion, selectStreams, type PipelineDefinition, type ReadContext } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal, createReadContext } from '@chkit/plugin-ingest/testing'

import { createSlackClient } from '../client.js'
import type { SlackReaderConfig } from '../config.js'
import * as definitions from '../index.js'
import { createSlackPipeline, slack } from '../pipeline.js'
import { readChannels } from '../sources/channels.js'
import { readMessages } from '../sources/messages.js'
import { messageScope, parseMessageState, slackMessageStrategy, type SlackMessageSelection, type SlackMessageState } from '../state.js'
import { channel, fixture, fixtureConfig, parentMessage, replyMessage, slackEnv, standaloneMessage, user } from './fixtures.js'

const fixtureNow = () => new Date('2023-11-15T00:00:00Z')
const retry = { retries: 1, minTimeout: 0, maxTimeout: 0, randomize: false }

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

  test('a pipeline binds installation identity, reader settings, and its token independently of later config edits', async () => {
    const config = { ...fixtureConfig, sourceId: 'slack.secondary', channels: ['C1'], conversationTypes: ['public_channel'] as const,
      includeReplies: false, pageSize: 37, messagePageSize: 12, historyFrom: '1699999999.000000', token: 'secondary-token' }
    const expectedScope = messageScope('T1', config)
    const requests: Array<{ url: URL; authorization: string | null }> = []
    const env = slackEnv((url, init) => { requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') }); return fixture(url) })
    const pipeline = createSlackPipeline(config)
    config.sourceId = 'changed'
    config.channels.push('missing')
    config.historyFrom = 'invalid'
    config.token = 'changed'
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    const result = await runIngestion(request(pipeline), { ...env, now: fixtureNow, journal, destination })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.streams.map((stream) => stream.streamId)).toEqual(['slack.secondary.channels', 'slack.secondary.users', 'slack.secondary.messages'])
    expect(parseMessageState((await journal.readCheckpoint('slack.secondary.messages')).envelope?.state).scope).toBe(expectedScope)
    expect(destination.tables.get('default.slack_messages_raw')?.[0]?.id).toBe(JSON.stringify(['slack.secondary', 'messages', 'T1', 'C1', parentMessage.ts]))
    expect(destination.tables.get('default.slack_users_raw')?.[0]?.raw).toMatchObject({ source_id: 'slack.secondary' })
    const urls = requests.map((entry) => entry.url)
    expect(urls.filter((url) => url.pathname === '/api/conversations.list' || url.pathname === '/api/users.list').every((url) => url.searchParams.get('limit') === '37')).toBe(true)
    expect(urls.find((url) => url.pathname === '/api/conversations.history')?.searchParams.get('limit')).toBe('12')
    expect(urls.find((url) => url.pathname === '/api/conversations.history')?.searchParams.get('oldest')).toBe('1699999998.999999')
    expect(urls.some((url) => url.pathname === '/api/conversations.replies')).toBe(false)
    expect(requests.every((entry) => entry.authorization === 'Bearer secondary-token')).toBe(true)
  })

  test('a failed resource leaves the other resource streams selectable and able to commit', async () => {
    const env = slackEnv((url) => url.pathname === '/api/users.list'
      ? Response.json({ ok: false, error: 'missing_scope', needed: 'users:read' }) : fixture(url))
    const pipeline = createSlackPipeline(fixtureConfig)
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    const result = await runIngestion(request(pipeline), { ...env, now: fixtureNow, journal, destination })
    expect(result.ok).toBe(false)
    expect(result.streams.map((stream) => stream.outcome)).toEqual(['succeeded', 'failed', 'succeeded'])
    expect(destination.tables.has('default.slack_channels_raw')).toBe(true)
    expect(destination.tables.has('default.slack_users_raw')).toBe(false)
    expect(destination.tables.has('default.slack_messages_raw')).toBe(true)
    expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state).active).toBeUndefined()
    expect((await journal.readCheckpoint('slack.primary.users')).envelope).toBeUndefined()
    expect(selectStreams([pipeline], ['resource:users']).map(({ stream }) => stream.id)).toEqual(['slack.primary.users'])
  })

  test('messages run before metadata streams and replay an unfinished page independently', async () => {
    const calls: string[] = []
    const env = slackEnv((url) => { calls.push(url.pathname); return fixture(url) })
    const pipeline = createSlackPipeline(fixtureConfig)
    const limited = { ...pipeline, streams: pipeline.streams.map((stream) => ({ ...stream, budget: { ...stream.budget, maxChunks: 2 } })) }
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    const first = await runIngestion({ selected: selectStreams([limited], ['resource:messages']), backfill: undefined }, { ...env, now: fixtureNow, journal, destination })
    expect(first.streams[0]?.outcome).toBe('budget_exhausted')
    const pending = await journal.readCheckpoint('slack.primary.messages')
    expect(parseMessageState(pending.envelope?.state).active?.latest).toBe('1700006400.000001')
    expect(parseMessageState(pending.envelope?.state).active).not.toHaveProperty('threads')
    expect(destination.tables.has('default.slack_channels_raw')).toBe(false)
    expect(destination.tables.has('default.slack_users_raw')).toBe(false)
    expect((await journal.readCheckpoint('slack.primary.channels')).version).toBe(0)
    expect((await journal.readCheckpoint('slack.primary.users')).version).toBe(0)
    calls.length = 0
    expect((await runIngestion({ selected: selectStreams([pipeline], ['resource:users']), backfill: undefined }, { ...env, now: fixtureNow, journal, destination })).ok).toBe(true)
    expect(calls).toEqual(['/api/auth.test', '/api/users.list'])
    expect(await journal.readCheckpoint('slack.primary.messages')).toEqual(pending)
    calls.length = 0
    expect((await runIngestion({ selected: selectStreams([pipeline], ['resource:messages']), backfill: undefined }, { ...env, now: fixtureNow, journal, destination })).ok).toBe(true)
    expect(calls).toEqual(['/api/auth.test', '/api/conversations.history', '/api/conversations.replies'])
    expect(destination.tables.get('default.slack_messages_raw')?.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: replyMessage })
    expect((await journal.readCheckpoint('slack.primary.channels')).version).toBe(0)
  })

  test('every stream preserves provider payloads and reruns publish edits under stable identities', async () => {
    let changed = false
    const env = slackEnv((url) => url.pathname === '/api/conversations.history' && changed
      ? Response.json({ ok: true, messages: [{ ...parentMessage, text: 'Edited discussion' }, standaloneMessage], response_metadata: { next_cursor: '' } })
      : fixture(url))
    const journal = createMemoryJournal()
    const destination = createMemoryDestination()
    const selected = request(fixturePipeline())
    const first = await runIngestion(selected, { ...env, now: fixtureNow, journal, destination, retry })
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
    const second = await runIngestion(selected, { ...env, now: fixtureNow, journal, destination, retry })
    expect(second.ok, JSON.stringify(second)).toBe(true)
    const repeated = destination.tables.get('default.slack_messages_raw') ?? []
    const edited = repeated.find((row) => JSON.stringify(row.raw).includes('Edited discussion'))
    expect(edited?.id).toBe(JSON.stringify(['slack.primary', 'messages', 'T1', 'C1', parentMessage.ts]))
    expect(new Set(repeated.map((row) => row.id)).size).toBe(3)
  })

  test('cursor pagination continues across an empty page and includes all later entities', async () => {
    const requests: URL[] = []
    const env = slackEnv((url) => {
      if (url.pathname !== '/api/conversations.list') return fixture(url)
      requests.push(url)
      const cursor = url.searchParams.get('cursor')
      if (cursor === null) return Response.json({ ok: true, channels: [], response_metadata: { next_cursor: 'empty-next' } })
      if (cursor === 'empty-next') return Response.json({ ok: true, channels: [channel], response_metadata: { next_cursor: 'final-next' } })
      if (cursor === 'final-next') return Response.json({ ok: true, channels: [{ ...channel, id: 'C2' }], response_metadata: { next_cursor: null } })
      throw new Error(`Unexpected cursor ${cursor}`)
    })
    const destination = createMemoryDestination()
    const result = await runFixture(env, ['channels'], destination, { ...fixtureConfig, pageSize: 2 })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(destination.tables.get('default.slack_channels_raw')?.map((row) => row.id)).toEqual(['C1', 'C2'].map((id) => JSON.stringify(['slack.primary', 'channels', 'T1', id])))
    expect(requests.map((url) => [url.searchParams.get('cursor'), url.searchParams.get('limit')])).toEqual([[null, '2'], ['empty-next', '2'], ['final-next', '2']])
  })

  test('the channels reader yields a page before fetching the next selected conversation page', async () => {
    let channelCalls = 0
    const iterator = readChannels(context((url) => {
      if (url.pathname !== '/api/conversations.list') return fixture(url)
      channelCalls += 1
      return Response.json({ ok: true, channels: [{ ...channel, id: channelCalls === 1 ? 'C1' : 'C2' }],
        response_metadata: { next_cursor: channelCalls === 1 ? 'next' : '' } })
    }), fixtureConfig)
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
    const iterator = readChannels(context(), { ...fixtureConfig, channels: ['C1', 'missing'] })
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value?.rows).toHaveLength(1)
    await expect(iterator.next()).rejects.toThrow('Configured Slack channel "missing" was not found')
  })

  test('messages discover channels independently and paginate threads including the parent payload', async () => {
    const requests: URL[] = []
    const chunks = await collect(readMessages(context((url) => {
      requests.push(url)
      if (url.pathname === '/api/conversations.history') return Response.json({ ok: true, messages: [parentMessage], response_metadata: { next_cursor: '' } })
      if (url.pathname === '/api/conversations.replies') {
        expect(url.searchParams.get('channel')).toBe('C1')
        expect(url.searchParams.get('ts')).toBe(parentMessage.ts)
        return url.searchParams.has('cursor')
          ? Response.json({ ok: true, messages: [replyMessage], response_metadata: { next_cursor: '' } })
          : Response.json({ ok: true, messages: [{ ...parentMessage, text: 'Latest parent' }], response_metadata: { next_cursor: 'reply-next' } })
      }
      return fixture(url)
    }), fixtureConfig))
    expect(chunks.flatMap((chunk) => chunk.rows).map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: { ...parentMessage, text: 'Latest parent' } })
    expect(chunks.flatMap((chunk) => chunk.rows)).toHaveLength(3)
    expect(chunks.filter((chunk) => chunk.rows.length > 0).every((chunk) => chunk.state === undefined)).toBe(true)
    expect(chunks.filter((chunk) => chunk.rows.length === 0).every((chunk) => chunk.state !== undefined)).toBe(true)
    expect(chunks.filter((chunk) => chunk.rows.length > 0).every((chunk) => chunk.id === undefined)).toBe(true)
    const messageRequests = requests.filter((url) => ['conversations.history', 'conversations.replies'].some((method) => url.pathname.endsWith(method)))
    expect(messageRequests.map((url) => url.searchParams.get('limit'))).toEqual(['15', '15', '15'])
    expect(messageRequests.at(-1)?.searchParams.get('cursor')).toBe('reply-next')
    expect(requests.some((url) => url.pathname === '/api/conversations.list')).toBe(true)
  })

  test('row identities separate source installations, workspaces, and conversations', async () => {
    const readForTeam = async (team: string, config: SlackReaderConfig = fixtureConfig) => collect(readMessages(context((url) => {
      if (url.pathname === '/api/auth.test') return Response.json({ ok: true, team_id: team })
      if (url.pathname === '/api/conversations.list') return Response.json({ ok: true, channels: [channel, { ...channel, id: 'C2' }], response_metadata: { next_cursor: '' } })
      if (url.pathname === '/api/conversations.history') return Response.json({ ok: true, messages: [standaloneMessage], response_metadata: { next_cursor: '' } })
      return fixture(url)
    }), config))
    const first = (await readForTeam('T1')).flatMap((chunk) => chunk.rows)
    const second = (await readForTeam('T2')).flatMap((chunk) => chunk.rows)
    const separateSource = (await readForTeam('T1', { ...fixtureConfig, sourceId: 'slack.secondary' })).flatMap((chunk) => chunk.rows)
    expect(new Set([...first, ...second, ...separateSource].map((row) => row.id)).size).toBe(6)
    expect(first[0]?.id).toBe(JSON.stringify(['slack.primary', 'messages', 'T1', 'C1', standaloneMessage.ts]))
  })

  test('finishes a history page and its replies before moving the timestamp frontier', async () => {
    const requests: string[] = []
    const chunks = await collect(readMessages(context((url) => {
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
      return fixture(url)
    }), fixtureConfig))
    expect(chunks.flatMap((chunk) => chunk.rows)).toHaveLength(4)
    expect(requests).toEqual(['history:first', 'replies', 'history:resumed'])
  })

  test('history-only selection avoids thread API requests', async () => {
    const requests: string[] = []
    const chunks = await collect(readMessages(context((url) => { requests.push(url.pathname); return fixture(url) }), { ...fixtureConfig, includeReplies: false }))
    expect(chunks.flatMap((chunk) => chunk.rows)).toHaveLength(2)
    expect(requests).not.toContain('/api/conversations.replies')
  })

  test('configured channel IDs narrow discovery and unknown IDs fail visibly', async () => {
    const discover = async (channels: readonly string[]) => {
      const client = createSlackClient(context((url) => url.pathname === '/api/conversations.list'
        ? Response.json({ ok: true, channels: [channel, { ...channel, id: 'C2' }], response_metadata: { next_cursor: '' } })
        : fixture(url)), { ...fixtureConfig, channels })
      return (await collect(client.conversations())).flatMap((page) => page.items.map((item) => item.id))
    }
    expect(await discover(['C1'])).toEqual(['C1'])
    await expect(discover(['missing'])).rejects.toThrow('missing')
    expect(await discover([])).toEqual([])
  })

  test('cancellation stops before the second history page', async () => {
    const controller = new AbortController()
    const requests: URL[] = []
    const iterator = readMessages(context((url) => {
      requests.push(url)
      return url.pathname === '/api/conversations.history'
        ? Response.json({ ok: true, messages: [standaloneMessage], response_metadata: { next_cursor: 'history-next' } })
        : fixture(url)
    }, controller.signal), fixtureConfig)
    const opening = await iterator.next()
    expect(opening.value?.rows).toHaveLength(0)
    const first = await iterator.next()
    expect(first.value?.rows).toHaveLength(1)
    controller.abort(new Error('fixture cancelled'))
    await expect(iterator.next()).rejects.toThrow('fixture cancelled')
    expect(requests.filter((url) => url.pathname === '/api/conversations.history')).toHaveLength(1)
  })

  test('malformed successful responses fail instead of becoming empty datasets', async () => {
    for (const payload of [{}, { ok: true, members: null }, { ok: true, members: [{ name: 'missing-id' }] }]) {
      const destination = createMemoryDestination()
      const result = await runFixture(slackEnv((url) => url.pathname === '/api/users.list' ? Response.json(payload) : fixture(url)), ['users'], destination)
      expect(result.streams[0]?.outcome).toBe('failed')
      expect(result.streams[0]?.error).toContain('Invalid input')
      expect(destination.tables.size).toBe(0)
    }
  })

  test('malformed message timestamps and pagination fail rather than truncate a scan', async () => {
    for (const { resource, payload, error } of [
      { resource: 'messages', payload: { ok: true, messages: [{ ...standaloneMessage, ts: 1_700_000_002.000003 }] }, error: 'expected string, received number' },
      { resource: 'messages', payload: { ok: true, messages: [{ ...standaloneMessage, ts: 'invalid' }] }, error: 'unmodified decimal timestamp string' },
      { resource: 'messages', payload: { ok: true, messages: [standaloneMessage], response_metadata: { next_cursor: 123 } }, error: 'expected string, received number' },
      { resource: 'users', payload: { ok: true, members: [user], has_more: true }, error: 'without a pagination cursor' },
    ]) {
      const method = resource === 'users' ? '/api/users.list' : '/api/conversations.history'
      const result = await runFixture(slackEnv((url) => url.pathname === method ? Response.json(payload) : fixture(url)), [resource])
      expect(result.streams[0]?.outcome).toBe('failed')
      expect(result.streams[0]?.error).toContain(error)
    }
    let calls = 0
    const repeated = slackEnv((url) => {
      if (url.pathname !== '/api/users.list') return fixture(url)
      calls += 1
      if (calls > 3) throw new Error('Repeated cursor was not rejected')
      return Response.json({ ok: true, members: [user], response_metadata: { next_cursor: 'same-cursor' } })
    })
    expect((await runFixture(repeated, ['users'])).streams[0]?.error).toContain('repeated')
    expect(calls).toBe(2)
  })

  test('HTTP 200 permission errors fail permanently without loading any rows', async () => {
    let calls = 0
    const env = slackEnv((url) => {
      if (url.pathname !== '/api/users.list') return fixture(url)
      calls += 1
      return Response.json({ ok: false, error: 'missing_scope', needed: 'users:read', provided: 'channels:read' })
    })
    const destination = createMemoryDestination()
    const result = await runFixture(env, ['users'], destination)
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.error).toContain('missing_scope')
    expect(result.streams[0]?.error).toContain('users:read')
    expect(result.streams[0]?.rows).toBe(0)
    expect(calls).toBe(1)
    expect(destination.tables.size).toBe(0)
  })

  test('HTTP 200 transient errors retry inside the ingestion executor', async () => {
    let calls = 0
    const env = slackEnv((url) => {
      if (url.pathname !== '/api/users.list') return fixture(url)
      calls += 1
      return calls === 1 ? Response.json({ ok: false, error: 'internal_error' }) : Response.json({ ok: true, members: [user], response_metadata: { next_cursor: '' } })
    })
    const result = await runFixture(env, ['users'])
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(calls).toBe(2)
  })

  test.each(['users', 'messages'])('%s pagination has one executor retry budget per request', async (resource) => {
    let calls = 0
    const method = resource === 'users' ? 'users.list' : 'conversations.history'
    const env = slackEnv((url) => {
      if (url.pathname !== `/api/${method}`) return fixture(url)
      calls += 1
      return Response.json({ ok: false, error: 'internal_error' })
    })
    const result = await runFixture(env, [resource])
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.outcome).toBe('failed')
    expect(calls).toBe(2)
  })

  test('HTTP 200 rate-limit errors retain Retry-After and retry under executor authority', async () => {
    let calls = 0
    const env = slackEnv((url) => {
      if (url.pathname !== '/api/users.list') return fixture(url)
      calls += 1
      return calls === 1
        ? Response.json({ ok: false, error: 'ratelimited' }, { headers: { 'Retry-After': '0' } })
        : Response.json({ ok: true, members: [user], response_metadata: { next_cursor: '' } })
    })
    const journal = createMemoryJournal()
    const result = await runIngestion(request(fixturePipeline(['users'])), { ...env, now: fixtureNow, journal, destination: createMemoryDestination(), retry })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(calls).toBe(2)
    expect(journal.events.some((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toBe(true)
  })

  test('thread permission errors fail the stream and leave already loaded history visible', async () => {
    let replyCalls = 0
    const env = slackEnv((url) => {
      if (url.pathname !== '/api/conversations.replies') return fixture(url)
      replyCalls += 1
      return Response.json({ ok: false, error: 'missing_scope', needed: 'channels:history' })
    })
    const destination = createMemoryDestination()
    const result = await runFixture(env, ['messages'], destination)
    expect(result.ok).toBe(false)
    expect(result.streams[0]?.outcome).toBe('failed')
    expect(result.streams[0]?.error).toContain('missing_scope')
    expect(replyCalls).toBe(1)
    expect(destination.tables.get('default.slack_messages_raw')).toHaveLength(2)
    expect(destination.tables.get('default.slack_messages_raw')?.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: parentMessage })
  })

  test('429 errors preserve Retry-After and retry the current page', async () => {
    let calls = 0
    const env = slackEnv((url) => {
      if (url.pathname !== '/api/users.list') return fixture(url)
      calls += 1
      return calls === 1
        ? Response.json({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json({ ok: true, members: [user], response_metadata: { next_cursor: '' } })
    })
    const journal = createMemoryJournal()
    const result = await runIngestion(request(fixturePipeline(['users'])), { ...env, now: fixtureNow, journal, destination: createMemoryDestination(), retry })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(calls).toBe(2)
    expect(journal.events.some((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toBe(true)
    const http = await HttpError.fromResponse(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
    expect(http.retryAfterMs).toBe(2_000)
  })

  test('a missing token fails each stream before any request, while the module loads without one', async () => {
    expect(slack.streams).toHaveLength(3)
    for (const token of [undefined, ' ']) {
      let requests = 0
      const result = await runIngestion(request(fixturePipeline(undefined, { ...fixtureConfig, token })), {
        fetch: async () => { requests += 1; throw new Error('must not fetch') },
        now: fixtureNow, journal: createMemoryJournal(), destination: createMemoryDestination(), retry,
      })
      expect(result.streams.map((stream) => stream.outcome)).toEqual(['failed', 'failed', 'failed'])
      expect(result.streams.every((stream) => stream.error?.includes('Set SLACK_API_TOKEN or pass token.'))).toBe(true)
      expect(requests).toBe(0)
    }
  })

  test('configuration is checked when a stream runs, not when the module loads or a stream is selected', async () => {
    let requests = 0
    const pipeline = createSlackPipeline({ ...fixtureConfig, conversationTypes: [], messagePageSize: 1_000, historyFrom: 'yesterday' })
    const selected = selectStreams([pipeline], [])
    expect(selected).toHaveLength(3)
    const result = await runIngestion({ selected, backfill: undefined }, {
      ...slackEnv(() => { requests += 1; return Response.json({}) }), now: fixtureNow, journal: createMemoryJournal(), destination: createMemoryDestination(),
    })
    expect(result.streams.every((stream) => stream.outcome === 'failed' && /at conversationTypes[\s\S]*at messagePageSize[\s\S]*at historyFrom/.test(stream.error ?? ''))).toBe(true)
    expect(requests).toBe(0)
  })

  test('a malformed provider payload fails at once and only a transient response is retried', async () => {
    let calls = 0
    const malformed = slackEnv((url) => {
      if (url.pathname !== '/api/users.list') return fixture(url)
      calls += 1
      return Response.json({ ok: true, members: 'not-a-list' })
    })
    const journal = createMemoryJournal()
    const result = await runIngestion(request(fixturePipeline(['users'])), { ...malformed, now: fixtureNow, journal, destination: createMemoryDestination(), retry })
    expect(result.streams[0]?.outcome).toBe('failed')
    expect(result.streams[0]?.error).toContain('Invalid input: expected array, received string')
    expect(calls).toBe(1)
    expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled')).toHaveLength(0)

    let unavailable = true
    const flaky = slackEnv((url) => {
      if (url.pathname === '/api/users.list' && unavailable) {
        unavailable = false
        return new Response('busy', { status: 503 })
      }
      return fixture(url)
    })
    const recovered = createMemoryJournal()
    const retried = await runIngestion(request(fixturePipeline(['users'])), { ...flaky, now: fixtureNow, journal: recovered, destination: createMemoryDestination(), retry })
    expect(retried.ok, JSON.stringify(retried)).toBe(true)
    expect(recovered.events.filter((event) => event.eventKind === 'retry_scheduled').map((event) => event.errorClass)).toEqual(['transient'])
  })
})

function fixturePipeline(resources?: readonly string[], config: SlackReaderConfig = fixtureConfig) {
  const pipeline = createSlackPipeline(config)
  return definePipeline({
    ...pipeline,
    streams: pipeline.streams.filter((stream) => resources === undefined || resources.includes(stream.id.split('.').at(-1) ?? '')),
  })
}

function runFixture(env: ReturnType<typeof slackEnv>, resources: readonly string[], destination = createMemoryDestination(), config?: SlackReaderConfig) {
  return runIngestion(request(fixturePipeline(resources, config)), { ...env, now: fixtureNow, journal: createMemoryJournal(), destination, retry })
}

function request(pipeline: PipelineDefinition) {
  return { selected: selectStreams([pipeline], []), backfill: undefined }
}

function context(handler?: Parameters<typeof slackEnv>[0], signal?: AbortSignal): ReadContext<SlackMessageSelection, SlackMessageState> {
  return createReadContext({
    fetch: slackEnv(handler).fetch, signal, streamId: 'slack.primary.messages', cutoff: fixtureNow(),
    selection: slackMessageStrategy.plan({ cutoff: fixtureNow(), state: undefined, range: undefined }),
  })
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}
