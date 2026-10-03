import type { FetchContext } from '@chkit/plugin-ingest'

import { discoverLists, entityId, entitySlug, readCollection, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export async function* readLists(context: FetchContext, deps?: AttioClientDeps) {
  yield { rows: toAttioRows(await discoverLists(context, deps), 'lists', ['workspace_id', 'list_id']) }
}

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

export async function* readEntries(context: FetchContext, deps?: AttioClientDeps) {
  for (const list of await discoverLists(context, deps)) {
    for await (const page of readCollection(context, {
      path: `/lists/${encodeURIComponent(entityId(list, 'list_id'))}/entries/query`,
      method: 'POST',
      idFields: ['workspace_id', 'list_id', 'entry_id'],
      valuesField: 'entry_values',
      pageSize: attioConfig.pageSize,
    }, deps)) {
      yield { rows: toAttioRows(page, 'entries', ['workspace_id', 'list_id', 'entry_id'], { list_slug: entitySlug(list) }) }
    }
  }
}
