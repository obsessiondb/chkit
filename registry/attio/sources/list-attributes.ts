import { rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createAttioClient } from '../client.js'
import { attioConfig, type AttioReaderConfig } from '../config.js'
import { readParentRows } from './common.js'

export const attioListAttributesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_list_attributes_raw` })

export async function* readListAttributes(context: SourceContext, list: string, config: AttioReaderConfig) {
  const client = createAttioClient(context, config)
  yield* readParentRows(client, {
    resource: 'list_attributes', parent: { kind: 'lists', ref: list },
    request: (parent) => ({
      path: `/lists/${encodeURIComponent(parent.id)}/attributes`,
      idFields: ['workspace_id', 'object_id', 'attribute_id'],
      // Attio's shared attribute schema calls the parent list ID object_id too.
      query: { show_archived: 'true' },
      pageSize: client.settings.pageSize,
    }),
  })
}
