import { rawTable } from '@chkit/plugin-ingest'

import { readCollectionScan, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'
import type { AttioReadContext } from '../checkpoints.js'

export const attioTasksRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_tasks_raw` })

export async function* readTasks(context: AttioReadContext, deps?: AttioClientDeps) {
  yield* readCollectionScan(context, 'tasks', {
    path: '/tasks', idFields: ['workspace_id', 'task_id'], pageSize: attioConfig.pageSize,
    query: { sort: 'created_at:asc' },
  }, deps)
}
