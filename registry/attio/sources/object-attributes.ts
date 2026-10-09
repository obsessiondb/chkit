import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { defaultAttioClientDeps, entityId, readParentCollection, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioObjectAttributesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_object_attributes_raw` })

export function readObjectAttributes(context: FetchContext, object: string, deps: AttioClientDeps = defaultAttioClientDeps) {
  return readParentCollection(context, {
    resource: 'object_attributes', parent: { kind: 'objects', ref: object },
    request: (parent) => ({
      path: `/objects/${encodeURIComponent(entityId(parent, 'object_id'))}/attributes`,
      idFields: ['workspace_id', 'object_id', 'attribute_id'],
      query: { show_archived: 'true' },
      pageSize: deps.config.pageSize,
    }),
  }, deps)
}
