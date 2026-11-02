import { rawRows, rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createLemlistClient } from '../client.js'
import { lemlistConfig, type LemlistReaderConfig } from '../config.js'

export const lemlist_inboxConversationsRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_inbox_conversations_raw' })

export async function* readInboxConversations(context: SourceContext, config: LemlistReaderConfig) {
  const client = createLemlistClient(context, config)
  const { sourceId, inboxUserIds } = client.settings
  const userIds = inboxUserIds?.length ? inboxUserIds : await client.teamUserIds()
  for (const userId of userIds) {
    for await (const page of client.inbox({ userId })) {
      yield { rows: rawRows(page.items.map((data) => ({ source_id: sourceId, user_id: userId, data })), ({ data }) => JSON.stringify([sourceId, userId, data._id])) }
    }
  }
}
