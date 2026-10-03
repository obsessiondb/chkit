import type { FetchContext } from '@chkit/plugin-ingest'

import { discoverObjects, entityId, entitySlug, readCollection, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export async function* readObjects(context: FetchContext, deps?: AttioClientDeps) {
  yield { rows: toAttioRows(await discoverObjects(context, deps), 'objects', ['workspace_id', 'object_id']) }
}

export async function* readObjectAttributes(context: FetchContext, deps?: AttioClientDeps) {
  for (const object of await discoverObjects(context, deps)) {
    for await (const page of readCollection(context, {
      path: `/objects/${encodeURIComponent(entityId(object, 'object_id'))}/attributes`,
      idFields: ['workspace_id', 'object_id', 'attribute_id'],
      query: { show_archived: 'true' },
      pageSize: attioConfig.pageSize,
    }, deps)) {
      yield { rows: toAttioRows(page, 'object_attributes', ['workspace_id', 'object_id', 'attribute_id'], { object_slug: entitySlug(object) }) }
    }
  }
}
