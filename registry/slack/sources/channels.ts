import { rawRows, rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createSlackClient } from '../client.js'
import { slackConfig, type SlackReaderConfig } from '../config.js'

export const slackChannelsRaw = rawTable({ database: slackConfig.database, name: `${slackConfig.tablePrefix}_channels_raw` })

export async function* readChannels(context: SourceContext, config: SlackReaderConfig) {
  const client = createSlackClient(context, config)
  const { sourceId } = client.settings
  const teamId = await client.workspace()
  for await (const page of client.conversations()) {
    yield { rows: rawRows(page.items.map((data) => ({ source_id: sourceId, team_id: teamId, data })), ({ data }) => JSON.stringify([sourceId, 'channels', teamId, data.id])) }
  }
}
