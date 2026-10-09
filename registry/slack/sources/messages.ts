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
  const initialFrom = context.selection.from ?? config.historyFrom ?? formatTimestamp(max(0n, timestampMicros(context.selection.to) - BigInt(config.overlapMs) * 1_000n))
  let state: SlackMessageState = context.state ?? { scope, watermark: initialFrom }
  if (!state.active) {
    const channels = (await discoverChannels(context, deps)).map((channel) => entityId(channel, 'id')).sort()
    const to = context.selection.to
    const from = context.selection.from ?? (context.state ? formatTimestamp(max(config.historyFrom === undefined ? 0n : timestampMicros(config.historyFrom), timestampMicros(state.watermark) - BigInt(config.overlapMs) * 1_000n)) : initialFrom)
    if (timestampMicros(from) > timestampMicros(to)) throw new IngestConfigError('Slack selection starts after its cutoff.')
    state = { ...state, active: { from, to, channels, channelIndex: 0, latest: formatTimestamp(timestampMicros(to) + 1n),
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
    const page = await readTimePage(context, { channel: channelId, oldest: formatTimestamp(max(0n, timestampMicros(work.from) - 1n)), latest: work.latest,
      inclusive: 'false', include_all_metadata: 'true' }, 'conversations.history', deps)
    assertRange(page.items, timestampMicros(work.from), timestampMicros(work.latest) - 1n)
    const latest = page.items.length ? formatTimestamp(page.items.reduce((oldest, item) => min(oldest, timestampMicros(entityId(item, 'ts'))), timestampMicros(work.latest))) : work.latest
    if (page.hasMore && (page.items.length === 0 || timestampMicros(latest) >= timestampMicros(work.latest))) throw new IngestConfigError('Slack history pagination has no safe timestamp progress.')
    const roots = config.includeReplies ? page.items.filter((item) => typeof item.reply_count === 'number' && item.reply_count > 0)
      .map((item) => typeof item.thread_ts === 'string' ? entityId(item, 'thread_ts') : entityId(item, 'ts')) : []
    if (page.items.length) yield { rows: toSlackRows(page.items, 'messages', teamId, 'ts', channelId, config.sourceId) }
    for (const root of new Set(roots)) {
      let after = formatTimestamp(max(0n, timestampMicros(root) - 1n))
      while (true) {
        const replies = await readTimePage(context, { channel: channelId, ts: root, oldest: after,
          latest: formatTimestamp(timestampMicros(work.to) + 1n), inclusive: 'false', include_all_metadata: 'true' }, 'conversations.replies', deps)
        const children = replies.items.filter((item) => entityId(item, 'ts') !== root)
        assertRange(children, timestampMicros(after) + 1n, timestampMicros(work.to))
        if (replies.hasMore && children.length === 0) throw new IngestConfigError('Slack thread pagination has no safe timestamp progress.')
        if (replies.items.length) yield { rows: toSlackRows(replies.items, 'messages', teamId, 'ts', channelId, config.sourceId) }
        if (!replies.hasMore) break
        after = formatTimestamp(children.reduce((frontier, item) => max(frontier, timestampMicros(entityId(item, 'ts'))), timestampMicros(after)))
      }
    }
    // Only a fully read history page and all its replies may advance durable history.
    context.signal.throwIfAborted()
    state = { ...state, active: { ...work, channelIndex: work.channelIndex + (page.hasMore ? 0 : 1),
      latest: page.hasMore ? latest : formatTimestamp(timestampMicros(work.to) + 1n) } }
    yield marker(state, 'history-page-complete')
  }
  if (state.active) {
    state = { scope, watermark: formatTimestamp(max(timestampMicros(state.watermark), timestampMicros(state.active.to))) }
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
