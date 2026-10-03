import type { FetchContext } from '@chkit/plugin-ingest'

import { discoverObjects, entityId, entitySlug, readCollection, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export async function* readRecords(context: FetchContext, deps?: AttioClientDeps) {
  // Discovery is local to this reader; the metadata stream need not have run.
  for (const object of await discoverObjects(context, deps)) {
    for await (const page of readCollection(context, {
      path: `/objects/${encodeURIComponent(entityId(object, 'object_id'))}/records/query`,
      method: 'POST',
      idFields: ['workspace_id', 'object_id', 'record_id'],
      valuesField: 'values',
      pageSize: attioConfig.pageSize,
    }, deps)) {
      // No checkpoint or page identity: offsets are not change cursors, and pages can mutate.
      yield { rows: toAttioRows(page, 'records', ['workspace_id', 'object_id', 'record_id'], { object_slug: entitySlug(object) }) }
    }
  }
}
