import { rawRows, rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createLemlistClient } from '../client.js'
import { lemlistConfig, type LemlistReaderConfig } from '../config.js'

export const lemlist_inboxMessagesRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_inbox_messages_raw' })

export async function* readInboxMessages(context: SourceContext, config: LemlistReaderConfig) {
  const client = createLemlistClient(context, config)
  const { sourceId } = client.settings
  // Discover all current contacts independently; recent parent/activity watermarks cannot cover late replies.
  for await (const contacts of client.list('contacts')) {
    for (const contact of contacts.items) {
      for await (const page of client.inbox({ contactId: contact._id })) {
        yield { rows: rawRows(page.items.map((data) => ({ source_id: sourceId, contact_id: contact._id, data })), ({ data }) => JSON.stringify([sourceId, contact._id, data._id])) }
      }
    }
  }
}
