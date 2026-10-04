import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { defaultAttioClientDeps, entityId, readParentCollection, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioEntriesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_entries_raw` })

export function readEntries(context: FetchContext, list: string, deps: AttioClientDeps = defaultAttioClientDeps) {
  return readParentCollection(context, {
    resource: 'entries', parent: { kind: 'lists', ref: list },
    request: (parent) => ({
      path: `/lists/${encodeURIComponent(entityId(parent, 'list_id'))}/entries/query`,
      idFields: ['workspace_id', 'list_id', 'entry_id'],
      method: 'POST',
      valuesField: 'entry_values',
      pageSize: deps.config.pageSize,
    }),
  }, deps)
}
