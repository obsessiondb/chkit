import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioObjectsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_objects_raw` })

export function readObjects(context: FetchContext, deps?: AttioClientDeps) {
  return readRows(context, {
    resource: 'objects', request: { path: '/objects', idFields: ['workspace_id', 'object_id'] },
  }, deps)
}
