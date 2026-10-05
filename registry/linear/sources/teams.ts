import { rawRows, rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import type { LinearClientDeps } from '../client.js'
import { linearId, readLinearPages } from './common.js'

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

export async function* readTeams(context: ReadContext<TimestampRange, TimestampWindowState>, deps: LinearClientDeps) {
  for await (const page of readLinearPages(context, {
    query, select: (data) => data.teams, label: 'teams', window: context.selection,
    variables: { from: context.selection.from.toISOString(), to: context.selection.to.toISOString() },
  }, deps)) yield { rows: rawRows(page.items, linearId) }
}
