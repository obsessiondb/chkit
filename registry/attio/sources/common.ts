import { rawRows } from '@chkit/plugin-ingest'

import { entityId, type AttioClient, type AttioEntity, type AttioParent, type CollectionRequest } from '../client.js'

interface RowMetadata {
  object_slug?: string
  list_slug?: string
}

export async function* readParentRows(client: AttioClient, input: {
  resource: string
  parent: { kind: 'objects' | 'lists'; ref: string }
  request: (parent: AttioParent) => CollectionRequest
}) {
  const parent = await client.parent(input.parent.kind, input.parent.ref)
  const field = input.parent.kind === 'objects' || input.resource === 'list_attributes' ? 'object_id' : 'list_id'
  yield* readRows(client, {
    resource: input.resource,
    request: { ...input.request(parent), parent: { field, id: parent.id, workspaceId: parent.workspaceId } },
    metadata: input.parent.kind === 'objects' ? { object_slug: parent.slug } : { list_slug: parent.slug },
  })
}

export async function* readRows(client: AttioClient, input: { resource: string; request: CollectionRequest; metadata?: RowMetadata }) {
  for await (const page of client.collection(input.request)) {
    yield { rows: attioRows(page.items, input.resource, input.request.idFields, client.settings.sourceId, input.metadata) }
  }
}

/** Original provider fields stay under data; metadata does not overwrite custom attributes. */
function attioRows(items: readonly AttioEntity[], resource: string, idFields: readonly string[], sourceId: string, metadata: RowMetadata = {}) {
  return rawRows(
    items.map((data) => ({ source_id: sourceId, ...metadata, data })),
    ({ data }) => JSON.stringify([sourceId, resource, ...idFields.map((field) => entityId(data, field))]),
  )
}
