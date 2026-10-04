import { rawTable } from '@chkit/plugin-ingest'

import { discoverObjects, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'
import { beginScan, type AttioReadContext } from '../checkpoints.js'

export const attioObjectsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_objects_raw` })

export async function* readObjects(context: AttioReadContext, deps?: AttioClientDeps) {
  const state = beginScan(context, 'objects')
  yield { rows: toAttioRows(await discoverObjects(context, deps), 'objects', ['workspace_id', 'object_id']), state: { ...state, phase: 'complete' as const } }
}
