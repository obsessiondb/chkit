import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readCollection, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioMembersRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_members_raw` })

export async function* readMembers(context: FetchContext, deps?: AttioClientDeps) {
  for await (const page of readCollection(context, {
    path: '/workspace_members', idFields: ['workspace_id', 'workspace_member_id'],
  }, deps)) {
    yield { rows: toAttioRows(page, 'members', ['workspace_id', 'workspace_member_id']) }
  }
}
