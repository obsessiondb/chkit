import { rawRows, rawTable, type ReadContext, type SourceChunk, type RawRow } from '@chkit/plugin-ingest'

import { createSlackClient, type MessageMethod, type SlackClient, type SlackMessage } from '../client.js'
import { slackConfig, type SlackReaderConfig } from '../config.js'
import { formatTimestamp, messageScope, timestampMicros, type SlackMessageSelection, type SlackMessageState } from '../state.js'

export const slackMessagesRaw = rawTable({ database: slackConfig.database, name: `${slackConfig.tablePrefix}_messages_raw` })

/** Temporary API cursors never enter the checkpoint; exact timestamps survive expiration. */
export async function* readMessages(
  context: ReadContext<SlackMessageSelection, SlackMessageState>,
  config: SlackReaderConfig,
): AsyncGenerator<SourceChunk<RawRow, SlackMessageState>> {
  const client = createSlackClient(context, config)
  const settings = client.settings
  const to = context.selection.to
  const initialFrom = context.selection.from ?? settings.historyFrom ?? formatTimestamp(max(0n, timestampMicros(to) - BigInt(settings.overlapMs) * 1_000n))
  const from = context.selection.from ?? (context.state ? formatTimestamp(max(settings.historyFrom === undefined ? 0n : timestampMicros(settings.historyFrom), timestampMicros(context.state.watermark) - BigInt(settings.overlapMs) * 1_000n)) : initialFrom)
  if (!context.state?.active && timestampMicros(from) > timestampMicros(to)) throw new Error('Slack selection starts after its cutoff.')
  const teamId = await client.workspace()
  const scope = messageScope(teamId, settings)
  if (context.state && context.state.scope !== scope) throw new Error('Slack checkpoint belongs to a different workspace or query. Restore the configuration or use a distinct sourceId.')
  let state: SlackMessageState = context.state ?? { scope, watermark: initialFrom }
  if (!state.active) {
    const channels = new Set<string>()
    for await (const page of client.conversations()) {
      for (const channel of page.items) channels.add(channel.id)
    }
    state = { ...state, active: { from, to, channels: [...channels].sort(), channelIndex: 0, latest: formatTimestamp(timestampMicros(to) + 1n),
      requestedFrom: context.selection.from, requestedTo: context.selection.requestedTo } }
    yield marker(state, 'window-open')
  } else if (context.selection.backfill && (context.selection.from !== state.active.requestedFrom || context.selection.requestedTo !== state.active.requestedTo)) {
    throw new Error('Slack backfill bounds changed while a window is unfinished. Resume the original range or use a new backfill ID.')
  }

  while (state.active && state.active.channelIndex < state.active.channels.length) {
    context.signal.throwIfAborted()
    const work = state.active
    const channelId = work.channels[work.channelIndex]
    if (!channelId) throw new Error('Slack checkpoint has no current channel.')
    const page = await readTimePage(client, { channel: channelId, oldest: formatTimestamp(max(0n, timestampMicros(work.from) - 1n)), latest: work.latest,
      inclusive: 'false', include_all_metadata: 'true' }, 'conversations.history')
    assertRange(page.items, timestampMicros(work.from), timestampMicros(work.latest) - 1n)
    const latest = page.items.length ? formatTimestamp(page.items.reduce((oldest, item) => min(oldest, timestampMicros(item.ts)), timestampMicros(work.latest))) : work.latest
    if (page.hasMore && (page.items.length === 0 || timestampMicros(latest) >= timestampMicros(work.latest))) throw new Error('Slack history pagination has no safe timestamp progress.')
    const roots = settings.includeReplies ? page.items.filter((item) => (item.reply_count ?? 0) > 0).map((item) => item.thread_ts ?? item.ts) : []
    if (page.items.length) yield { rows: messageRows(page.items, settings.sourceId, teamId, channelId) }
    for (const root of new Set(roots)) {
      let after = formatTimestamp(max(0n, timestampMicros(root) - 1n))
      while (true) {
        const replies = await readTimePage(client, { channel: channelId, ts: root, oldest: after,
          latest: formatTimestamp(timestampMicros(work.to) + 1n), inclusive: 'false', include_all_metadata: 'true' }, 'conversations.replies')
        const children = replies.items.filter((item) => item.ts !== root)
        assertRange(children, timestampMicros(after) + 1n, timestampMicros(work.to))
        if (replies.hasMore && children.length === 0) throw new Error('Slack thread pagination has no safe timestamp progress.')
        if (replies.items.length) yield { rows: messageRows(replies.items, settings.sourceId, teamId, channelId) }
        if (!replies.hasMore) break
        after = formatTimestamp(children.reduce((frontier, item) => max(frontier, timestampMicros(item.ts)), timestampMicros(after)))
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
async function readTimePage(client: SlackClient, query: Record<string, string>, method: MessageMethod): Promise<{ items: SlackMessage[]; hasMore: boolean }> {
  let restarted = false
  const parents = new Map<string, SlackMessage>()
  while (true) {
    let continued = false
    for await (const page of client.messages(method, query)) {
      if (page.metadata?.cursorExpired) {
        if (!continued || restarted) throw new Error(`Slack ${method} pagination cursor expired.`)
        restarted = true
        break
      }
      for (const item of page.items) parents.set(item.ts, item)
      if (page.next === undefined) return { items: [...parents.values()], hasMore: page.metadata?.hasMore === true }
      continued = true
    }
  }
}

function messageRows(items: readonly SlackMessage[], sourceId: string, teamId: string, channelId: string): RawRow[] {
  return rawRows(items.map((data) => ({ source_id: sourceId, team_id: teamId, channel_id: channelId, data })), ({ data }) => JSON.stringify([sourceId, 'messages', teamId, channelId, data.ts]))
}
function marker(state: SlackMessageState, id: string): SourceChunk<RawRow, SlackMessageState> {
  // State-only boundaries flush previous rows without assigning identity to mutable data.
  return { rows: [], state, id }
}
function assertRange(items: SlackMessage[], from: bigint, to: bigint): void {
  if (items.some((item) => {
    const ts = timestampMicros(item.ts)
    return ts < from || ts > to
  })) throw new Error('Slack returned a message outside the requested timestamp interval.')
}
function max(left: bigint, right: bigint): bigint { return left > right ? left : right }
function min(left: bigint, right: bigint): bigint { return left < right ? left : right }
