import { IngestConfigError, rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readPages, requestLemlist, requireItems, toLemlistRows, type LemlistClientDeps } from '../client.js'
import { lemlistConfig } from '../config.js'

export const lemlist_contactsRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_contacts_raw' })

export async function* readContacts(context: FetchContext, deps: LemlistClientDeps) {
  for await (const listed of readPages(context, 'contacts', undefined, deps)) {
    // List items omit custom fields; hydrate complete objects of the same resource in <=100-ID batches.
    const contacts = await context.attempt(async (signal) => {
      const items = requireItems(await requestLemlist('/contacts', { idsOrEmails: listed.map((item) => item._id).join(',') }, signal, deps), 'contact lookup')
      const expected = new Set(listed.map((item) => item._id))
      if (items.length !== listed.length || items.some((item) => !expected.has(item._id))) {
        throw new IngestConfigError('Lemlist contact lookup did not return every discovered contact; replay this stream.')
      }
      return items
    }, { label: 'GET /contacts by IDs' })
    yield { rows: toLemlistRows(contacts, deps) }
  }
}
