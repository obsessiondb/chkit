import { rawTable } from '@chkit/plugin-ingest'

import { discoverLists, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'
import { beginScan, type AttioReadContext } from '../checkpoints.js'

export const attioListsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_lists_raw` })

export async function* readLists(context: AttioReadContext, deps?: AttioClientDeps) {
  const state = beginScan(context, 'lists')
  yield { rows: toAttioRows(await discoverLists(context, deps), 'lists', ['workspace_id', 'list_id']), state: { ...state, phase: 'complete' as const } }
}
