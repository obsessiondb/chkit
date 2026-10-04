import { rawTable } from '@chkit/plugin-ingest'

import { readParentCollections, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'
import type { AttioReadContext } from '../checkpoints.js'

export const attioObjectAttributesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_object_attributes_raw` })

export async function* readObjectAttributes(context: AttioReadContext, deps?: AttioClientDeps) {
  yield* readParentCollections(context, {
    resource: 'object_attributes', parents: 'objects', idFields: ['workspace_id', 'object_id', 'attribute_id'],
    request: (parent) => ({
      path: `/objects/${encodeURIComponent(parent.id)}/attributes`,
      idFields: ['workspace_id', 'object_id', 'attribute_id'],
      query: { show_archived: 'true' },
      pageSize: attioConfig.pageSize,
    }),
  }, deps)
}
