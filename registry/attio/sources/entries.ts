import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { discoverLists, entityId, entitySlug, readCollection, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioEntriesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_entries_raw` })

export async function* readEntries(context: FetchContext, deps?: AttioClientDeps) {
  for (const list of await discoverLists(context, deps)) {
    for await (const page of readCollection(context, {
      path: `/lists/${encodeURIComponent(entityId(list, 'list_id'))}/entries/query`,
      method: 'POST',
      idFields: ['workspace_id', 'list_id', 'entry_id'],
      valuesField: 'entry_values',
      pageSize: attioConfig.pageSize,
    }, deps)) {
      yield { rows: toAttioRows(page, 'entries', ['workspace_id', 'list_id', 'entry_id'], { list_slug: entitySlug(list) }) }
    }
  }
}
