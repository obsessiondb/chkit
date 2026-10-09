import { afterEach, expect, test } from 'bun:test'
import { definePipeline, defineStream, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { slackConfig } from '../config.js'
import { readMessages, slackMessagesRaw } from '../sources/messages.js'
import { createSlackMessageStrategy, dateTimestamp, parseMessageState, timestampMicros } from '../state.js'
import { fixtureDeps, parentMessage, replyMessage, standaloneMessage } from './fixtures.js'
import type { SlackClientDeps } from '../client.js'

const originalConfig = { ...slackConfig }
const cutoff = new Date('2023-11-15T00:00:00Z')
afterEach(() => { Object.assign(slackConfig, originalConfig) })

test('an incomplete history page replays its replies under the original frozen bounds', async () => {
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const calls: URL[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => { calls.push(url); return defaults.fetch(url.toString(), init) })
  const first = await runIngestion(request(pipeline(deps, { maxChunks: 2 })), { journal, destination, now: () => cutoff })
  expect(first.streams[0]?.outcome).toBe('budget_exhausted')
  const saved = parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)
  expect(saved.watermark).toBe('1699920000.000000')
  expect(saved.active).toMatchObject({ from: '1699920000.000000', to: dateTimestamp(cutoff), latest: '1700006400.000001', channelIndex: 0 })
  expect(saved.active).not.toHaveProperty('threads')
  const restored = createMemoryJournal()
  await restored.append(journal.events.map((event) => ({ ...event,
    checkpoint: event.checkpoint === undefined ? undefined : JSON.parse(JSON.stringify(event.checkpoint)),
  })))
  calls.length = 0
  const second = await runIngestion(request(pipeline(deps)), { journal: restored, destination, now: () => new Date('2023-11-16T00:00:00Z') })
  expect(second.ok, JSON.stringify(second)).toBe(true)
  expect(calls.map((url) => url.pathname)).toEqual(['/api/auth.test', '/api/conversations.history', '/api/conversations.replies'])
  expect(calls.filter((url) => url.pathname.endsWith('history') || url.pathname.endsWith('replies')).every((url) => url.searchParams.get('latest') === '1700006400.000001')).toBe(true)
  const completed = parseMessageState((await restored.readCheckpoint('slack.primary.messages')).envelope?.state)
  expect(completed.active).toBeUndefined()
  expect(completed.watermark).toBe(dateTimestamp(cutoff))
  expect(destination.tables.get('default.slack_messages_raw')?.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: replyMessage })
})

test('lost child acknowledgement replays the whole history page without advancing it', async () => {
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const controller = new AbortController()
  const first = await runIngestion(request(pipeline(fixtureDeps())), {
    journal, now: () => cutoff, signal: controller.signal,
    destination: { async insert(input) {
      await destination.insert(input)
      if (input.rows.some((row) => JSON.stringify(row.raw).includes(replyMessage.text))) controller.abort(new Error('lost child acknowledgement'))
    } },
  })
  expect(first.ok).toBe(false)
  const saved = parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)
  expect(saved.active?.latest).toBe('1700006400.000001')
  expect(saved.active?.channelIndex).toBe(0)
  const calls: string[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => { calls.push(url.pathname); return defaults.fetch(url.toString(), init) })
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(calls).toEqual(['/api/auth.test', '/api/conversations.history', '/api/conversations.replies'])
  expect(destination.tables.get('default.slack_messages_raw')).toHaveLength(4)
  expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state).active).toBeUndefined()
})

test('multi-page replies use local ascending timestamps and restart the incomplete thread on resume', async () => {
  const secondReply = { ...replyMessage, ts: '1700000001.000003', text: 'Second reply' }
  const oldest: string[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname !== '/api/conversations.replies') return defaults.fetch(url.toString(), init)
    oldest.push(url.searchParams.get('oldest') ?? '')
    const final = url.searchParams.get('oldest') === replyMessage.ts
    return Response.json({ ok: true, messages: final ? [secondReply] : [parentMessage, replyMessage], has_more: !final })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline(deps, { maxChunks: 3 })), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const saved = parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)
  expect(saved.active?.latest).toBe('1700006400.000001')
  expect(saved.active).not.toHaveProperty('threads')
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(oldest).toEqual(['1700000000.000000', '1700000000.000000', replyMessage.ts])
  expect(destination.tables.get('default.slack_messages_raw')?.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: secondReply })
})

test('a completed history page resumes from an exact timestamp rather than an expiring cursor', async () => {
  slackConfig.includeReplies = false
  const newest = { ...standaloneMessage, ts: '1700000002.000002' }
  const older = { ...standaloneMessage, ts: '1700000002.000001' }
  const urls: URL[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname !== '/api/conversations.history') return defaults.fetch(url.toString(), init)
    urls.push(url)
    const resumed = url.searchParams.get('latest') === newest.ts
    return Response.json({ ok: true, messages: [resumed ? older : newest], has_more: !resumed })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline(deps, { maxChunks: 3 })), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const saved = parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)
  expect(saved.active?.latest).toBe(newest.ts)
  expect(JSON.stringify(saved)).not.toContain('cursor')
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(urls.map((url) => url.searchParams.get('latest'))).toEqual(['1700006400.000001', newest.ts])
  expect(urls.every((url) => !url.searchParams.has('cursor'))).toBe(true)
  expect(new Set(destination.tables.get('default.slack_messages_raw')?.map((row) => row.id)).size).toBe(2)
})

test('empty history cursor pages precede the completed timestamp boundary', async () => {
  slackConfig.includeReplies = false
  const urls: URL[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname !== '/api/conversations.history') return defaults.fetch(url.toString(), init)
    urls.push(url)
    if (url.searchParams.get('latest') === standaloneMessage.ts) return Response.json({ ok: true, messages: [parentMessage], has_more: false })
    return Response.json(url.searchParams.has('cursor')
      ? { ok: true, messages: [standaloneMessage], has_more: true, response_metadata: { next_cursor: 'empty-page' } }
      : { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: 'empty-page' } })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline(deps, { maxChunks: 3 })), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const saved = parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)
  expect(saved.active?.latest).toBe(standaloneMessage.ts)
  expect(JSON.stringify(saved)).not.toContain('empty-page')
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(urls.map((url) => [url.searchParams.get('cursor'), url.searchParams.get('latest')])).toEqual([
    [null, '1700006400.000001'], ['empty-page', '1700006400.000001'], [null, standaloneMessage.ts],
  ])
})

test('a page too large for the chunk budget replays until the budget can include its completion marker', async () => {
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const deps = fixtureDeps()
  const small = request(pipeline(deps, { maxChunks: 2 }))
  expect((await runIngestion(small, { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  const checkpoint = await journal.readCheckpoint('slack.primary.messages')
  expect((await runIngestion(small, { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await journal.readCheckpoint('slack.primary.messages')).version).toBe(checkpoint.version)
  expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state).active?.channelIndex).toBe(0)
  expect((await runIngestion(request(pipeline(deps, { maxChunks: 5 })), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(new Set(destination.tables.get('default.slack_messages_raw')?.map((row) => row.id)).size).toBe(3)
})

test('default bootstrap is recent and subsequent passes overlap the completed watermark by 24 hours', async () => {
  const oldest: string[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname !== '/api/conversations.history') return defaults.fetch(url.toString(), init)
    oldest.push(url.searchParams.get('oldest') ?? '')
    return Response.json({ ok: true, messages: [], has_more: false })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => new Date('2023-11-15T12:00:00Z') })).ok).toBe(true)
  expect(oldest).toEqual(['1699919999.999999', '1699919999.999999'])
  expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state).watermark).toBe('1700049600.000000')
})

test('recent roots gain replies during overlap while old roots and their late replies stay outside normal coverage', async () => {
  const recentRoot = { ...parentMessage, ts: dateTimestamp(new Date('2023-11-15T06:00:00Z')), thread_ts: dateTimestamp(new Date('2023-11-15T06:00:00Z')) }
  const recentReply = { ...replyMessage, ts: dateTimestamp(new Date('2023-11-15T07:00:00Z')), thread_ts: recentRoot.ts, text: 'Recent reply' }
  const oldLateReply = { ...replyMessage, ts: dateTimestamp(new Date('2023-11-17T06:00:00Z')), text: 'Old root late reply' }
  let now = new Date('2023-11-15T06:30:00Z')
  const roots: string[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname === '/api/conversations.history') {
      const from = timestampMicros(url.searchParams.get('oldest') ?? '0.000000')
      const to = timestampMicros(url.searchParams.get('latest') ?? '0.000000')
      return Response.json({ ok: true, messages: [parentMessage, recentRoot].filter((item) => timestampMicros(item.ts) > from && timestampMicros(item.ts) < to), has_more: false })
    }
    if (url.pathname === '/api/conversations.replies') {
      const root = url.searchParams.get('ts') ?? ''
      roots.push(root)
      const to = timestampMicros(url.searchParams.get('latest') ?? '0.000000')
      return Response.json({ ok: true, messages: root === recentRoot.ts
        ? [recentRoot, recentReply].filter((item) => timestampMicros(item.ts) < to)
        : [parentMessage, replyMessage, oldLateReply].filter((item) => timestampMicros(item.ts) < to), has_more: false })
    }
    return defaults.fetch(url.toString(), init)
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const execute = () => runIngestion(request(pipeline(deps)), { journal, destination, now: () => now })
  expect((await execute()).ok).toBe(true)
  now = new Date('2023-11-15T08:00:00Z')
  expect((await execute()).ok).toBe(true)
  expect(destination.tables.get('default.slack_messages_raw')?.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: recentReply })
  now = new Date('2023-11-16T08:00:00Z')
  expect((await execute()).ok).toBe(true)
  now = new Date('2023-11-17T08:00:00Z')
  expect((await execute()).ok).toBe(true)
  roots.length = 0
  now = new Date('2023-11-24T08:00:00Z')
  expect((await execute()).ok).toBe(true)
  expect(roots).toEqual([])
  expect(destination.tables.get('default.slack_messages_raw')?.some((row) => JSON.stringify(row.raw).includes(oldLateReply.text))).toBe(false)
})

test('an explicit historyFrom expands initial coverage without periodic historical reconciliation', async () => {
  slackConfig.historyFrom = '0.000000'
  const bounds: string[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname !== '/api/conversations.history') return defaults.fetch(url.toString(), init)
    bounds.push(url.searchParams.get('oldest') ?? '')
    return Response.json({ ok: true, messages: [], has_more: false })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => new Date('2023-11-23T00:00:00Z') })).ok).toBe(true)
  expect(bounds).toEqual(['0.000000', '1699919999.999999'])
})

test('empty terminal pages commit progress and query or account changes reject saved state', async () => {
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => url.pathname === '/api/conversations.history'
    ? Response.json({ ok: true, messages: [], has_more: false }) : defaults.fetch(url.toString(), init))
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state).watermark).toBe(dateTimestamp(cutoff))
  expect(destination.tables.size).toBe(0)
  const otherTeam = fixtureDeps((url, init) => url.pathname === '/api/auth.test' ? Response.json({ ok: true, team_id: 'T2' }) : defaults.fetch(url.toString(), init))
  expect((await runIngestion(request(pipeline(otherTeam)), { journal, destination, now: () => cutoff })).streams[0]?.error).toContain('different workspace or query')
  slackConfig.includeReplies = false
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).streams[0]?.error).toContain('different workspace or query')
  expect(() => parseMessageState({ scope: 'broken', watermark: 1700006400 })).toThrow('timestamp')
})

test('backfills isolate normal progress and retain requested bounds through a coarse-page pause', async () => {
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const backfill = { id: 'november', from: new Date('2023-11-14T00:00:00Z'), to: cutoff }
  const selected = selectStreams([pipeline(fixtureDeps(), { maxChunks: 2 })], [])
  expect((await runIngestion({ selected, backfill }, { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await journal.readCheckpoint('slack.primary.messages')).envelope).toBeUndefined()
  const changed = await runIngestion({ selected: selectStreams([pipeline(fixtureDeps())], []), backfill: { ...backfill, to: new Date('2023-11-16T00:00:00Z') } }, { journal, destination, now: () => cutoff })
  expect(changed.ok).toBe(false)
  expect(changed.streams[0]?.error).toContain('bounds changed')
  expect((await runIngestion({ selected: selectStreams([pipeline(fixtureDeps())], []), backfill }, { journal, destination, now: () => cutoff })).ok).toBe(true)
})

test('a backfill without an explicit upper bound resumes its original cutoff', async () => {
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const backfill = { id: 'open-ended', from: new Date('2023-11-14T00:00:00Z'), to: undefined }
  expect((await runIngestion({ selected: selectStreams([pipeline(fixtureDeps(), { maxChunks: 2 })], []), backfill }, { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  expect((await runIngestion({ selected: selectStreams([pipeline(fixtureDeps())], []), backfill }, { journal, destination, now: () => new Date('2023-11-16T00:00:00Z') })).ok).toBe(true)
  expect((await journal.readCheckpoint('slack.primary.messages')).envelope).toBeUndefined()
  expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages#backfill:open-ended')).envelope?.state).watermark).toBe(dateTimestamp(cutoff))
})

test('strategy version 2 rejects old envelopes before making requests', async () => {
  const deps = fixtureDeps(), journal = createMemoryJournal(), destination = createMemoryDestination()
  const current = pipeline(deps, { maxChunks: 1 })
  const old = { ...current, streams: current.streams.map((stream) => ({ ...stream, incremental: { ...stream.incremental, version: 1 } })) }
  expect((await runIngestion(request(old), { journal, destination, now: () => cutoff })).streams[0]?.outcome).toBe('budget_exhausted')
  let calls = 0
  const unused = fixtureDeps(() => { calls += 1; throw new Error('Old checkpoint must fail before requesting') })
  const result = await runIngestion(request(pipeline(unused)), { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('slack.message-ranges@1')
  expect(result.streams[0]?.error).toContain('slack.message-ranges@2')
  expect(calls).toBe(0)
  expect(() => parseMessageState({ scope: 'old', watermark: '0.000000', knownChannels: [] })).toThrow('former retained-work format')
})

test('expired temporary reply cursors replay their bounds and retain the newest parent observation', async () => {
  const cursors: string[] = []
  const updatedParent = { ...parentMessage, text: 'Updated parent' }
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname !== '/api/conversations.replies') return defaults.fetch(url.toString(), init)
    const cursor = url.searchParams.get('cursor') ?? ''
    cursors.push(cursor)
    if (cursor === 'expired') return Response.json({ ok: false, error: 'invalid_cursor' })
    if (cursor === 'current') return Response.json({ ok: true, messages: [updatedParent, replyMessage], has_more: false })
    return Response.json({ ok: true, messages: [parentMessage], has_more: true, response_metadata: { next_cursor: cursors.length === 1 ? 'expired' : 'current' } })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(cursors).toEqual(['', 'expired', '', 'current'])
  expect(destination.tables.get('default.slack_messages_raw')?.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: updatedParent })
  expect(JSON.stringify((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)).not.toContain('cursor')
})

test.each(['initial', 'after-replay'])('a rejected reply cursor %s leaves the entire history page unfinished', async (failure) => {
  const cursors: Array<string | null> = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname !== '/api/conversations.replies') return defaults.fetch(url.toString(), init)
    const cursor = url.searchParams.get('cursor')
    cursors.push(cursor)
    return Response.json(failure === 'initial' || cursor
      ? { ok: false, error: 'invalid_cursor' }
      : { ok: true, messages: [parentMessage], has_more: true, response_metadata: { next_cursor: 'expired' } })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const result = await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams[0]?.error).toContain('cursor expired')
  expect(cursors).toEqual(failure === 'initial' ? [null] : [null, 'expired', null, 'expired'])
  expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state).active?.latest).toBe('1700006400.000001')
  expect(destination.tables.get('default.slack_messages_raw')?.map((row) => row.raw)).not.toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: replyMessage })
})

function pipeline(deps: SlackClientDeps, budget?: { maxChunks?: number }) {
  return definePipeline({ id: 'slack.primary', retry: { retries: 0 }, streams: [defineStream({
    id: 'slack.primary.messages', destination: slackMessagesRaw, incremental: createSlackMessageStrategy(deps.config), batchSize: 1, budget,
    read: (context) => readMessages(context, deps),
  })] })
}
function request(value: ReturnType<typeof pipeline>) { return { selected: selectStreams([value], []), backfill: undefined } }
