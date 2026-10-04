import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { defaultAttioClientDeps, readRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioTasksRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_tasks_raw` })

export function readTasks(context: FetchContext, deps: AttioClientDeps = defaultAttioClientDeps) {
  return readRows(context, {
    resource: 'tasks', request: {
      path: '/tasks', idFields: ['workspace_id', 'task_id'], pageSize: deps.config.pageSize,
      query: { sort: 'created_at:asc' },
    },
  }, deps)
}
