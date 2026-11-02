import { rawRows, rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createSlackClient } from '../client.js'
import { slackConfig, type SlackReaderConfig } from '../config.js'

export const slackUsersRaw = rawTable({ database: slackConfig.database, name: `${slackConfig.tablePrefix}_users_raw` })

export async function* readUsers(context: SourceContext, config: SlackReaderConfig) {
  const client = createSlackClient(context, config)
  const { sourceId } = client.settings
  const teamId = await client.workspace()
  for await (const page of client.users()) {
    yield { rows: rawRows(page.items.map((data) => ({ source_id: sourceId, team_id: teamId, data })), ({ data }) => JSON.stringify([sourceId, 'users', teamId, data.id])) }
  }
}
