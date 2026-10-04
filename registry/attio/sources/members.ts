import { rawTable } from '@chkit/plugin-ingest'

import { readCollectionScan, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'
import type { AttioReadContext } from '../checkpoints.js'

export const attioMembersRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_members_raw` })

export async function* readMembers(context: AttioReadContext, deps?: AttioClientDeps) {
  yield* readCollectionScan(context, 'members', {
    path: '/workspace_members', idFields: ['workspace_id', 'workspace_member_id'],
  }, deps)
}
