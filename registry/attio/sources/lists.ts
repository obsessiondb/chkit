import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { discoverLists, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioListsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_lists_raw` })

export async function* readLists(context: FetchContext, deps?: AttioClientDeps) {
  yield { rows: toAttioRows(await discoverLists(context, deps), 'lists', ['workspace_id', 'list_id']) }
}
