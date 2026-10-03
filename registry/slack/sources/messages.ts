import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { discoverChannels, entityId, getWorkspace, readCollection, toSlackRows, type SlackClientDeps } from '../client.js'
import { slackConfig } from '../config.js'

export const slackMessagesRaw = rawTable({ database: slackConfig.database, name: `${slackConfig.tablePrefix}_messages_raw` })

/** Full scans revisit old roots as well as recent messages, including late thread replies. */
export async function* readMessages(context: FetchContext, deps?: SlackClientDeps) {
  const teamId = await getWorkspace(context, deps)
  for (const channel of await discoverChannels(context, deps)) {
    const channelId = entityId(channel, 'id')
    const threads = new Set<string>()
    for await (const page of readCollection(context, {
      method: 'conversations.history', field: 'messages', idField: 'ts',
      query: { channel: channelId, include_all_metadata: 'true' },
    }, deps)) {
      yield { rows: toSlackRows(page, 'messages', teamId, 'ts', channelId) }
      if (!slackConfig.includeReplies) continue
      for (const message of page) {
        if (typeof message.reply_count !== 'number' || message.reply_count === 0) continue
        const root = typeof message.thread_ts === 'string' ? entityId(message, 'thread_ts') : entityId(message, 'ts')
        threads.add(root)
      }
    }
    // Finish history pagination before scanning threads: a long thread must not leave
    // the history cursor idle for hours, since Slack cursors expire.
    for (const root of threads) {
      for await (const replies of readCollection(context, {
        method: 'conversations.replies', field: 'messages', idField: 'ts',
        query: { channel: channelId, ts: root, include_all_metadata: 'true' },
      }, deps)) {
        // Slack repeats the parent; the shared channel/ts identity reconciles observations.
        yield { rows: toSlackRows(replies, 'messages', teamId, 'ts', channelId) }
      }
    }
  }
}
