import { rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createAttioClient } from '../client.js'
import { attioConfig, type AttioReaderConfig } from '../config.js'
import { readRows } from './common.js'

export const attioObjectsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_objects_raw` })

export async function* readObjects(context: SourceContext, config: AttioReaderConfig) {
  const client = createAttioClient(context, config)
  yield* readRows(client, {
    resource: 'objects', request: { path: '/objects', idFields: ['workspace_id', 'object_id'] },
  })
}
