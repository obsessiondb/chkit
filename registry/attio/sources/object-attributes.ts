import { rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createAttioClient } from '../client.js'
import { attioConfig, type AttioReaderConfig } from '../config.js'
import { readParentRows } from './common.js'

export const attioObjectAttributesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_object_attributes_raw` })

export async function* readObjectAttributes(context: SourceContext, object: string, config: AttioReaderConfig) {
  const client = createAttioClient(context, config)
  yield* readParentRows(client, {
    resource: 'object_attributes', parent: { kind: 'objects', ref: object },
    request: (parent) => ({
      path: `/objects/${encodeURIComponent(parent.id)}/attributes`,
      idFields: ['workspace_id', 'object_id', 'attribute_id'],
      query: { show_archived: 'true' },
      pageSize: client.settings.pageSize,
    }),
  })
}
