import type { FetchContext } from '@chkit/plugin-ingest'

import { readCollection, toAttioRows, type AttioClientDeps } from '../client.js'

export async function* readMembers(context: FetchContext, deps?: AttioClientDeps) {
  for await (const page of readCollection(context, {
    path: '/workspace_members', idFields: ['workspace_id', 'workspace_member_id'],
  }, deps)) {
    yield { rows: toAttioRows(page, 'members', ['workspace_id', 'workspace_member_id']) }
  }
}
