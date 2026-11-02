import { rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createAttioClient } from '../client.js'
import { attioConfig, type AttioReaderConfig } from '../config.js'
import { readRows } from './common.js'

export const attioTasksRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_tasks_raw` })

export async function* readTasks(context: SourceContext, config: AttioReaderConfig) {
  const client = createAttioClient(context, config)
  yield* readRows(client, {
    resource: 'tasks', request: {
      path: '/tasks', idFields: ['workspace_id', 'task_id'], pageSize: client.settings.pageSize,
      query: { sort: 'created_at:asc' },
    },
  })
}
