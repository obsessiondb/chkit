import { rawRows, rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { createLinearClient } from '../client.js'
import type { LinearConfig } from '../config.js'
import { linearId } from './common.js'

const query = `query Teams($after: String, $from: DateTimeOrDuration!, $to: DateTimeOrDuration!) {
  teams(first: 100, after: $after, includeArchived: true, orderBy: updatedAt,
    filter: { updatedAt: { gte: $from, lte: $to } }) {
    nodes { id name key description icon color timezone visibility retiredAt
      cyclesEnabled cycleStartDay cycleDuration cycleCooldownTime createdAt updatedAt archivedAt
      parent { id } organization { id }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const linear_teamsRaw = rawTable({ database: 'default', name: 'linear_teams_raw' })

export async function* readTeams(context: ReadContext<TimestampRange, TimestampWindowState>, config: LinearConfig) {
  const client = createLinearClient(context, config)
  for await (const page of client.connection({
    query, path: ['teams'], label: 'teams', window: context.selection,
    variables: { from: context.selection.from.toISOString(), to: context.selection.to.toISOString() },
  })) yield { rows: rawRows(page.items, linearId) }
}
