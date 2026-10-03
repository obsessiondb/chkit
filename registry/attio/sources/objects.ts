import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { discoverObjects, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioObjectsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_objects_raw` })

export async function* readObjects(context: FetchContext, deps?: AttioClientDeps) {
  yield { rows: toAttioRows(await discoverObjects(context, deps), 'objects', ['workspace_id', 'object_id']) }
}
