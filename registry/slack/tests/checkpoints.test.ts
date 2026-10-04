import { afterEach, expect, test } from 'bun:test'
import { definePipeline, defineStream, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { slackConfig } from '../config.js'
import { readMessages, slackMessagesRaw } from '../sources/messages.js'
import { dateTimestamp, parseMessageState, slackMessageStrategy, timestampMicros } from '../state.js'
import { fixtureDeps, parentMessage, replyMessage, standaloneMessage } from './fixtures.js'
import type { SlackClientDeps } from '../client.js'

const originalConfig = { ...slackConfig }
const cutoff = new Date('2023-11-15T00:00:00Z')
afterEach(() => { Object.assign(slackConfig, originalConfig) })

test('a fresh process resumes retained threads before advancing the frozen history window', async () => {
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const calls: string[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => { calls.push(url.pathname); return defaults.fetch(url.toString(), init) })
  const limited = pipeline(deps, { maxChunks: 2 })
  const first = await runIngestion(request(limited), { journal, destination, now: () => cutoff })
  expect(first.streams[0]?.outcome).toBe('budget_exhausted')
  const saved = parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)
  expect(saved.watermark).toBe(slackConfig.historyFrom)
  expect(saved.active?.to).toBe(dateTimestamp(cutoff))
  expect(saved.active?.threads).toEqual([{ root: parentMessage.ts }])
  expect(saved.active?.historyDone).toBe(true)
  calls.length = 0
  const second = await runIngestion(request(pipeline(deps)), { journal, destination, now: () => new Date('2023-11-16T00:00:00Z') })
  expect(second.ok, JSON.stringify(second)).toBe(true)
  expect(calls).toEqual(['/api/auth.test', '/api/conversations.replies'])
  const completed = parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)
  expect(completed.active).toBeUndefined()
  expect(completed.watermark).toBe(dateTimestamp(cutoff))
  expect(destination.tables.get('default.slack_messages_raw')?.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: replyMessage })
})

test('a lost destination acknowledgement cannot move the history frontier past unpublished journal progress', async () => {
  slackConfig.includeReplies = false
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const controller = new AbortController()
  const first = await runIngestion(request(pipeline(fixtureDeps())), {
    journal, now: () => cutoff, signal: controller.signal,
    destination: { async insert(input) { await destination.insert(input); controller.abort(new Error('lost acknowledgement')) } },
  })
  expect(first.ok).toBe(false)
  const saved = parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)
  expect(saved.active?.latest).toBe('1700006400.000001')
  expect(saved.active?.historyDone).toBe(false)
  const second = await runIngestion(request(pipeline(fixtureDeps())), { journal, destination, now: () => cutoff })
  expect(second.ok, JSON.stringify(second)).toBe(true)
  expect(destination.tables.get('default.slack_messages_raw')).toHaveLength(2)
  expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state).active).toBeUndefined()
})

test('history resumes newest-first without saving expiring cursors or converting timestamp precision', async () => {
  slackConfig.includeReplies = false
  const newest = { ...standaloneMessage, ts: '1700000002.000002' }
  const older = { ...standaloneMessage, ts: '1700000002.000001' }
  const requests: URL[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname !== '/api/conversations.history') return defaults.fetch(url.toString(), init)
    requests.push(url)
    return Response.json({ ok: true, messages: [url.searchParams.get('latest') === newest.ts ? older : newest], has_more: url.searchParams.get('latest') !== newest.ts })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline(deps, { maxChunks: 2 })), { journal, destination, now: () => cutoff })).ok).toBe(false)
  const saved = parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)
  expect(saved.active?.latest).toBe(newest.ts)
  expect(JSON.stringify(saved)).not.toContain('cursor')
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(requests.map((url) => url.searchParams.get('latest'))).toEqual(['1700006400.000001', newest.ts])
  expect(requests.every((url) => !url.searchParams.has('cursor'))).toBe(true)
  expect(new Set(destination.tables.get('default.slack_messages_raw')?.map((row) => row.id)).size).toBe(2)
})

test('thread reply pages resume from their ascending timestamp frontier', async () => {
  const secondReply = { ...replyMessage, ts: '1700000001.000003', text: 'Second reply' }
  const oldest: string[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname !== '/api/conversations.replies') return defaults.fetch(url.toString(), init)
    oldest.push(url.searchParams.get('oldest') ?? '')
    const resumed = url.searchParams.get('oldest') === replyMessage.ts
    return Response.json({ ok: true, messages: resumed ? [secondReply] : [parentMessage, replyMessage], has_more: !resumed })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const first = await runIngestion(request(pipeline(deps, { maxChunks: 3 })), { journal, destination, now: () => cutoff })
  expect(first.streams[0]?.outcome).toBe('budget_exhausted')
  expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state).active?.threads[0]?.after).toBe(replyMessage.ts)
  const second = await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })
  expect(second.ok, JSON.stringify(second)).toBe(true)
  expect(oldest).toEqual(['1700000000.000000', replyMessage.ts])
  expect(destination.tables.get('default.slack_messages_raw')?.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: secondReply })
})

test('periodic full reconciliation captures new replies on roots outside recent overlap', async () => {
  let now = cutoff, late = false
  const lateReply = { ...replyMessage, ts: dateTimestamp(new Date('2023-11-16T12:00:00Z')), text: 'Late reply' }
  const historyBounds: string[] = []
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname === '/api/conversations.history') {
      const from = timestampMicros(url.searchParams.get('oldest') ?? '0.000000')
      historyBounds.push(url.searchParams.get('oldest') ?? '')
      return Response.json({ ok: true, messages: timestampMicros(parentMessage.ts) > from ? [parentMessage] : [], has_more: false })
    }
    if (url.pathname === '/api/conversations.replies') return Response.json({ ok: true, messages: [parentMessage, replyMessage, ...(late ? [lateReply] : [])], has_more: false })
    return defaults.fetch(url.toString(), init)
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const execute = () => runIngestion(request(pipeline(deps)), { journal, destination, now: () => now })
  expect((await execute()).ok).toBe(true)
  now = new Date('2023-11-16T00:00:00Z')
  expect((await execute()).ok).toBe(true)
  late = true
  now = new Date('2023-11-17T00:00:00Z')
  expect((await execute()).ok).toBe(true)
  expect(destination.tables.get('default.slack_messages_raw')?.some((row) => JSON.stringify(row.raw).includes('Late reply'))).toBe(false)
  now = new Date('2023-11-23T00:00:00Z')
  expect((await execute()).ok).toBe(true)
  expect(historyBounds[0]).toBe('0.000000')
  expect(historyBounds[1]).not.toBe('0.000000')
  expect(historyBounds[2]).not.toBe('0.000000')
  expect(historyBounds[3]).toBe('0.000000')
  expect(destination.tables.get('default.slack_messages_raw')?.some((row) => JSON.stringify(row.raw).includes('Late reply'))).toBe(true)
})

test('empty final pages commit progress and account/query changes reject saved state', async () => {
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => url.pathname === '/api/conversations.history'
    ? Response.json({ ok: true, messages: [], has_more: false }) : defaults.fetch(url.toString(), init))
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(parseMessageState((await journal.readCheckpoint('slack.primary.messages')).envelope?.state).watermark).toBe(dateTimestamp(cutoff))
  expect(destination.tables.size).toBe(0)
  slackConfig.includeReplies = false
  const failed = await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })
  expect(failed.ok).toBe(false)
  expect(failed.streams[0]?.error).toContain('different workspace or query')
  expect(() => parseMessageState({ scope: 'broken', watermark: 1700006400, knownChannels: [] })).toThrow('timestamp')
})

test('date-bound backfills isolate normal progress and reject changed unfinished bounds', async () => {
  slackConfig.includeReplies = false
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const selected = selectStreams([pipeline(fixtureDeps(), { maxChunks: 1 })], [])
  const backfill = { id: 'november', from: new Date('2023-11-14T00:00:00Z'), to: cutoff }
  expect((await runIngestion({ selected, backfill }, { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('slack.primary.messages')).envelope).toBeUndefined()
  const changed = await runIngestion({ selected: selectStreams([pipeline(fixtureDeps())], []), backfill: { ...backfill, to: new Date('2023-11-16T00:00:00Z') } }, { journal, destination, now: () => cutoff })
  expect(changed.ok).toBe(false)
  expect(changed.streams[0]?.error).toContain('bounds changed')
  expect((await runIngestion({ selected: selectStreams([pipeline(fixtureDeps())], []), backfill }, { journal, destination, now: () => cutoff })).ok).toBe(true)
})

test('a backfill without an explicit upper bound retains its cutoff across process restarts', async () => {
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const backfill = { id: 'open-ended', from: new Date('2023-11-14T00:00:00Z'), to: undefined }
  const first = await runIngestion({ selected: selectStreams([pipeline(fixtureDeps(), { maxChunks: 2 })], []), backfill }, { journal, destination, now: () => cutoff })
  expect(first.streams[0]?.outcome).toBe('budget_exhausted')
  const second = await runIngestion({ selected: selectStreams([pipeline(fixtureDeps())], []), backfill }, { journal, destination, now: () => new Date('2023-11-16T00:00:00Z') })
  expect(second.ok, JSON.stringify(second)).toBe(true)
  expect((await journal.readCheckpoint('slack.primary.messages')).envelope).toBeUndefined()
  expect(new Set(destination.tables.get('default.slack_messages_raw')?.map((row) => row.id)).size).toBe(3)
})

test('expired temporary cursors replay thread bounds and keep the latest repeated parent payload', async () => {
  const requests: string[] = []
  const updatedParent = { ...parentMessage, text: 'Updated parent' }
  const defaults = fixtureDeps()
  const deps = fixtureDeps((url, init) => {
    if (url.pathname !== '/api/conversations.replies') return defaults.fetch(url.toString(), init)
    const cursor = url.searchParams.get('cursor') ?? ''
    requests.push(cursor)
    if (cursor === 'expired') return Response.json({ ok: false, error: 'invalid_cursor' })
    if (cursor === 'current') return Response.json({ ok: true, messages: [updatedParent, replyMessage], has_more: false })
    return Response.json({ ok: true, messages: [parentMessage], has_more: true, response_metadata: { next_cursor: requests.length === 1 ? 'expired' : 'current' } })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const result = await runIngestion(request(pipeline(deps)), { journal, destination, now: () => cutoff })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  expect(requests).toEqual(['', 'expired', '', 'current'])
  const rows = destination.tables.get('default.slack_messages_raw') ?? []
  // One history observation plus one enriched thread observation; cursor pages do not add an older duplicate.
  expect(rows.filter((row) => (row.raw as { data: { ts: string } }).data.ts === parentMessage.ts)).toHaveLength(2)
  expect(rows.map((row) => row.raw)).toContainEqual({ source_id: 'slack.primary', team_id: 'T1', channel_id: 'C1', data: updatedParent })
  expect(JSON.stringify((await journal.readCheckpoint('slack.primary.messages')).envelope?.state)).not.toContain('cursor')
})

function pipeline(deps: SlackClientDeps, budget?: { maxChunks?: number }) {
  return definePipeline({ id: 'slack.primary', retry: { retries: 0 }, streams: [defineStream({
    id: 'slack.primary.messages', destination: slackMessagesRaw, incremental: slackMessageStrategy, batchSize: 1, budget,
    read: (context) => readMessages(context, deps),
  })] })
}
function request(value: ReturnType<typeof pipeline>) { return { selected: selectStreams([value], []), backfill: undefined } }
