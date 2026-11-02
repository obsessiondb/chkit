import { rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createAttioClient } from '../client.js'
import { attioConfig, type AttioReaderConfig } from '../config.js'
import { readRows } from './common.js'

export const attioListsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_lists_raw` })

export async function* readLists(context: SourceContext, config: AttioReaderConfig) {
  const client = createAttioClient(context, config)
  yield* readRows(client, {
    resource: 'lists', request: { path: '/lists', idFields: ['workspace_id', 'list_id'] },
  })
}
