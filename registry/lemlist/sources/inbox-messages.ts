import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readInboxPages, readPages, toLemlistRows, type LemlistClientDeps } from '../client.js'
import { lemlistConfig } from '../config.js'

export const lemlist_inboxMessagesRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_inbox_messages_raw' })

export async function* readInboxMessages(context: FetchContext, deps: LemlistClientDeps) {
  // Discover all current contacts independently; recent parent/activity watermarks cannot cover late replies.
  for await (const contacts of readPages(context, 'contacts', undefined, deps)) {
    for (const contact of contacts.items) {
      for await (const page of readInboxPages(context, { contactId: contact._id }, deps)) {
        yield { rows: toLemlistRows(page.items, deps, { contact_id: contact._id }) }
      }
    }
  }
}
