import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { defaultAttioClientDeps, entityId, readParentCollection, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioListAttributesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_list_attributes_raw` })

export function readListAttributes(context: FetchContext, list: string, deps: AttioClientDeps = defaultAttioClientDeps) {
  return readParentCollection(context, {
    resource: 'list_attributes', parent: { kind: 'lists', ref: list },
    request: (parent) => ({
      path: `/lists/${encodeURIComponent(entityId(parent, 'list_id'))}/attributes`,
      idFields: ['workspace_id', 'object_id', 'attribute_id'],
      // Attio's shared attribute schema calls the parent list ID object_id too.
      query: { show_archived: 'true' },
      pageSize: deps.config.pageSize,
    }),
  }, deps)
}
