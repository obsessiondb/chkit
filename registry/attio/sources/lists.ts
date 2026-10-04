import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioListsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_lists_raw` })

export function readLists(context: FetchContext, deps?: AttioClientDeps) {
  return readRows(context, {
    resource: 'lists', request: { path: '/lists', idFields: ['workspace_id', 'list_id'] },
  }, deps)
}
