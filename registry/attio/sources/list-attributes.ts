import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { discoverLists, entityId, entitySlug, readCollection, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioListAttributesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_list_attributes_raw` })

export async function* readListAttributes(context: FetchContext, deps?: AttioClientDeps) {
  for (const list of await discoverLists(context, deps)) {
    for await (const page of readCollection(context, {
      path: `/lists/${encodeURIComponent(entityId(list, 'list_id'))}/attributes`,
      // Attio's shared attribute schema calls the parent list ID "object_id" too.
      idFields: ['workspace_id', 'object_id', 'attribute_id'],
      query: { show_archived: 'true' },
      pageSize: attioConfig.pageSize,
    }, deps)) {
      yield { rows: toAttioRows(page, 'list_attributes', ['workspace_id', 'object_id', 'attribute_id'], { list_slug: entitySlug(list) }) }
    }
  }
}
