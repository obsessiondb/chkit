import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { discoverChannels, getWorkspace, toSlackRows, type SlackClientDeps } from '../client.js'
import { slackConfig } from '../config.js'

export const slackChannelsRaw = rawTable({ database: slackConfig.database, name: `${slackConfig.tablePrefix}_channels_raw` })

export async function* readChannels(context: FetchContext, deps?: SlackClientDeps) {
  const teamId = await getWorkspace(context, deps)
  yield { rows: toSlackRows(await discoverChannels(context, deps), 'channels', teamId, 'id') }
}
