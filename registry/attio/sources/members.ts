import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioMembersRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_members_raw` })

export function readMembers(context: FetchContext, deps?: AttioClientDeps) {
  return readRows(context, {
    resource: 'members', request: {
      path: '/workspace_members', idFields: ['workspace_id', 'workspace_member_id'],
    },
  }, deps)
}
