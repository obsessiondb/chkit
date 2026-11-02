import { rawRows, rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createLemlistClient } from '../client.js'
import { lemlistConfig, type LemlistReaderConfig } from '../config.js'

export const lemlist_contactsRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_contacts_raw' })

export async function* readContacts(context: SourceContext, config: LemlistReaderConfig) {
  const client = createLemlistClient(context, config)
  const { sourceId } = client.settings
  for await (const page of client.list('contacts')) {
    if (page.items.length === 0) continue
    // List items omit custom fields; hydrate complete objects of the same resource in <=100-ID batches.
    const contacts = await client.contacts(page.items.map((item) => item._id))
    yield { rows: rawRows(contacts.map((data) => ({ source_id: sourceId, data })), ({ data }) => JSON.stringify([sourceId, data._id])) }
  }
}
