import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { getWorkspace, readCollection, toSlackRows, type SlackClientDeps } from '../client.js'
import { slackConfig } from '../config.js'

export const slackUsersRaw = rawTable({ database: slackConfig.database, name: `${slackConfig.tablePrefix}_users_raw` })

export async function* readUsers(context: FetchContext, deps?: SlackClientDeps) {
  const teamId = await getWorkspace(context, deps)
  for await (const page of readCollection(context, { method: 'users.list', field: 'members', idField: 'id' }, deps)) {
    yield { rows: toSlackRows(page, 'users', teamId, 'id') }
  }
}
