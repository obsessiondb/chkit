import { rawTable } from '@chkit/plugin-ingest'

import { readParentCollections, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'
import type { AttioReadContext } from '../checkpoints.js'

export const attioListAttributesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_list_attributes_raw` })

export async function* readListAttributes(context: AttioReadContext, deps?: AttioClientDeps) {
  yield* readParentCollections(context, {
    resource: 'list_attributes', parents: 'lists', idFields: ['workspace_id', 'object_id', 'attribute_id'],
    request: (parent) => ({
      path: `/lists/${encodeURIComponent(parent.id)}/attributes`,
      idFields: ['workspace_id', 'object_id', 'attribute_id'],
      // Attio's shared attribute schema calls the parent list ID object_id too.
      query: { show_archived: 'true' },
      pageSize: attioConfig.pageSize,
    }),
  }, deps)
}
