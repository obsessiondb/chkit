import { rawTable } from '@chkit/plugin-ingest'

import { readParentCollections, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'
import type { AttioReadContext } from '../checkpoints.js'

export const attioEntriesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_entries_raw` })

export async function* readEntries(context: AttioReadContext, deps?: AttioClientDeps) {
  yield* readParentCollections(context, {
    resource: 'entries', parents: 'lists', idFields: ['workspace_id', 'list_id', 'entry_id'],
    request: (parent) => ({
      path: `/lists/${encodeURIComponent(parent.id)}/entries/query`,
      idFields: ['workspace_id', 'list_id', 'entry_id'],
      method: 'POST',
      valuesField: 'entry_values',
      pageSize: attioConfig.pageSize,
    }),
  }, deps)
}
