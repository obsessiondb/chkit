import { IngestConfigError, rawTable, type ReadContext, type SourceChunk, type RawRow } from '@chkit/plugin-ingest'

import { defaultSlackClientDeps, discoverChannels, entityId, getWorkspace, readCollection, SlackCursorExpiredError, toSlackRows, type SlackClientDeps, type SlackEntity } from '../client.js'
import { slackConfig } from '../config.js'
import { formatTimestamp, messageScope, timestampMicros, type SlackMessageSelection, type SlackMessageState } from '../state.js'

export const slackMessagesRaw = rawTable({ database: slackConfig.database, name: `${slackConfig.tablePrefix}_messages_raw` })

/** Temporary API cursors never enter the checkpoint; exact timestamps survive expiration. */
export async function* readMessages(
  context: ReadContext<SlackMessageSelection, SlackMessageState>,
  deps: SlackClientDeps = defaultSlackClientDeps,
): AsyncGenerator<SourceChunk<RawRow, SlackMessageState>> {
  const config = deps.config
  const teamId = await getWorkspace(context, deps)
  const scope = messageScope(teamId, config)
  if (context.state && context.state.scope !== scope) throw new IngestConfigError('Slack checkpoint belongs to a different workspace or query. Restore the configuration or use a distinct sourceId.')
  let state: SlackMessageState = context.state ?? { scope, watermark: config.historyFrom, knownChannels: [] }
  if (!state.active) {
    const channels = (await discoverChannels(context, deps)).map((channel) => entityId(channel, 'id')).sort()
    const to = context.selection.to
    const full = state.lastFullAt === undefined || timestampMicros(to) - timestampMicros(state.lastFullAt) >= BigInt(config.reconcileIntervalMs) * 1_000n
    const from = context.selection.from ?? (full ? config.historyFrom : formatTimestamp(max(timestampMicros(config.historyFrom), timestampMicros(state.watermark) - BigInt(config.overlapMs) * 1_000n)))
    if (timestampMicros(from) > timestampMicros(to)) throw new IngestConfigError('Slack selection starts after its cutoff.')
    state = { ...state, active: { kind: context.selection.backfill ? 'backfill' : full ? 'full' : 'incremental', from, to, channels, channelIndex: 0,
      latest: formatTimestamp(timestampMicros(to) + 1n), historyDone: false, threads: [],
      requestedFrom: context.selection.from, requestedTo: context.selection.requestedTo } }
    yield marker(state, 'window-open')
  } else if (context.selection.backfill && (context.selection.from !== state.active.requestedFrom || context.selection.requestedTo !== state.active.requestedTo)) {
    throw new IngestConfigError('Slack backfill bounds changed while a window is unfinished. Resume the original range or use a new backfill ID.')
  }

  while (state.active && state.active.channelIndex < state.active.channels.length) {
    context.signal.throwIfAborted()
    const work = state.active
    const channelId = work.channels[work.channelIndex]
    if (!channelId) throw new IngestConfigError('Slack checkpoint has no current channel.')
    const thread = work.threads[0]
    if (thread) {
      const after = thread.after ?? formatTimestamp(max(0n, timestampMicros(thread.root) - 1n))
      const page = await readTimePage(context, { channel: channelId, ts: thread.root, oldest: after,
        latest: formatTimestamp(timestampMicros(work.to) + 1n), inclusive: 'false', include_all_metadata: 'true' }, 'conversations.replies', deps)
      const replies = page.items.filter((item) => entityId(item, 'ts') !== thread.root)
      assertRange(replies, timestampMicros(after) + 1n, timestampMicros(work.to))
      const frontier = replies.length ? formatTimestamp(replies.reduce((latest, item) => max(latest, timestampMicros(entityId(item, 'ts'))), timestampMicros(after))) : undefined
      if (page.hasMore && frontier === undefined) throw new IngestConfigError('Slack thread pagination has no safe timestamp progress.')
      const threads = page.hasMore ? [{ root: thread.root, after: frontier }, ...work.threads.slice(1)] : work.threads.slice(1)
      state = { ...state, active: { ...work, threads } }
      yield page.items.length ? { rows: toSlackRows(page.items, 'messages', teamId, 'ts', channelId, config.sourceId), state } : marker(state, 'thread-complete')
      continue
    }
    if (work.historyDone) {
      state = { ...state, active: { ...work, channelIndex: work.channelIndex + 1, latest: formatTimestamp(timestampMicros(work.to) + 1n), historyDone: false } }
      yield marker(state, 'channel-complete')
      continue
    }
    const from = work.kind === 'incremental' && !state.knownChannels.includes(channelId) ? config.historyFrom : work.from
    const page = await readTimePage(context, { channel: channelId, oldest: formatTimestamp(max(0n, timestampMicros(from) - 1n)), latest: work.latest,
      inclusive: 'false', include_all_metadata: 'true' }, 'conversations.history', deps)
    assertRange(page.items, timestampMicros(from), timestampMicros(work.latest) - 1n)
    const latest = page.items.length ? formatTimestamp(page.items.reduce((oldest, item) => min(oldest, timestampMicros(entityId(item, 'ts'))), timestampMicros(work.latest))) : work.latest
    if (page.hasMore && (page.items.length === 0 || timestampMicros(latest) >= timestampMicros(work.latest))) throw new IngestConfigError('Slack history pagination has no safe timestamp progress.')
    const roots = config.includeReplies ? page.items.filter((item) => typeof item.reply_count === 'number' && item.reply_count > 0)
      .map((item) => typeof item.thread_ts === 'string' ? entityId(item, 'thread_ts') : entityId(item, 'ts')) : []
    state = { ...state, active: { ...work, latest, historyDone: !page.hasMore, threads: [...new Set(roots)].map((root) => ({ root })) } }
    // The page retains its bounded child queue before the history frontier advances durably.
    yield page.items.length ? { rows: toSlackRows(page.items, 'messages', teamId, 'ts', channelId, config.sourceId), state } : marker(state, 'history-complete')
  }
  if (state.active) {
    const { to, kind, channels } = state.active
    state = { scope, watermark: formatTimestamp(max(timestampMicros(state.watermark), timestampMicros(to))),
      knownChannels: [...new Set([...state.knownChannels, ...channels])].sort(), lastFullAt: kind === 'full' ? to : state.lastFullAt }
    yield marker(state, 'window-complete')
  }
}

/** Empty cursor pages use the live cursor; nonempty pages establish timestamp boundaries. */
async function readTimePage(
  context: ReadContext<SlackMessageSelection, SlackMessageState>, query: Record<string, string>,
  method: 'conversations.history' | 'conversations.replies', deps?: SlackClientDeps,
): Promise<{ items: SlackEntity[]; hasMore: boolean }> {
  let restarted = false
  const parents = new Map<string, SlackEntity>()
  while (true) {
    let continued = false
    try {
      for await (const page of readCollection(context, { method, field: 'messages', idField: 'ts', query, timePagination: true }, deps)) {
        for (const item of page.items) parents.set(entityId(item, 'ts'), item)
        if (page.next === undefined) return { items: [...parents.values()], hasMore: page.metadata?.hasMore === true }
        continued = true
      }
    } catch (error) {
      if (!(error instanceof SlackCursorExpiredError) || !continued || restarted) throw error
      restarted = true
    }
  }
}

function marker(state: SlackMessageState, id: string): SourceChunk<RawRow, SlackMessageState> {
  // State-only boundaries flush previous rows without assigning identity to mutable data.
  return { rows: [], state, id }
}
function assertRange(items: SlackEntity[], from: bigint, to: bigint): void {
  if (items.some((item) => {
    const ts = timestampMicros(entityId(item, 'ts'))
    return ts < from || ts > to
  })) throw new IngestConfigError('Slack returned a message outside the requested timestamp interval.')
}
function max(left: bigint, right: bigint): bigint { return left > right ? left : right }
function min(left: bigint, right: bigint): bigint { return left < right ? left : right }
