import type { FetchContext } from '@chkit/plugin-ingest'

import { readCollection, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export async function* readTasks(context: FetchContext, deps?: AttioClientDeps) {
  for await (const page of readCollection(context, {
    path: '/tasks', idFields: ['workspace_id', 'task_id'], pageSize: attioConfig.pageSize,
    query: { sort: 'created_at:asc' },
  }, deps)) {
    yield { rows: toAttioRows(page, 'tasks', ['workspace_id', 'task_id']) }
  }
}
