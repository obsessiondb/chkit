import { rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createAttioClient } from '../client.js'
import { attioConfig, type AttioReaderConfig } from '../config.js'
import { readParentRows } from './common.js'

export const attioEntriesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_entries_raw` })

export async function* readEntries(context: SourceContext, list: string, config: AttioReaderConfig) {
  const client = createAttioClient(context, config)
  yield* readParentRows(client, {
    resource: 'entries', parent: { kind: 'lists', ref: list },
    request: (parent) => ({
      path: `/lists/${encodeURIComponent(parent.id)}/entries/query`,
      idFields: ['workspace_id', 'list_id', 'entry_id'],
      method: 'POST',
      valuesField: 'entry_values',
      pageSize: client.settings.pageSize,
    }),
  })
}
