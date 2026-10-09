import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { defaultSlackClientDeps, getWorkspace, readChannelPages, toSlackRows, type SlackClientDeps } from '../client.js'
import { slackConfig } from '../config.js'

export const slackChannelsRaw = rawTable({ database: slackConfig.database, name: `${slackConfig.tablePrefix}_channels_raw` })

export async function* readChannels(context: FetchContext, deps: SlackClientDeps = defaultSlackClientDeps) {
  const teamId = await getWorkspace(context, deps)
  for await (const page of readChannelPages(context, deps)) {
    yield { rows: toSlackRows(page.items, 'channels', teamId, 'id', undefined, deps.config.sourceId) }
  }
}
