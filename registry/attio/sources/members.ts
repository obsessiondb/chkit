import { rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createAttioClient } from '../client.js'
import { attioConfig, type AttioReaderConfig } from '../config.js'
import { readRows } from './common.js'

export const attioMembersRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_members_raw` })

export async function* readMembers(context: SourceContext, config: AttioReaderConfig) {
  const client = createAttioClient(context, config)
  yield* readRows(client, {
    resource: 'members', request: {
      path: '/workspace_members', idFields: ['workspace_id', 'workspace_member_id'],
    },
  })
}
