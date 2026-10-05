import { rawRows, rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import type { LinearClientDeps } from '../client.js'
import { linearId, readLinearPages } from './common.js'

const query = `query ProjectUpdates($after: String, $from: DateTimeOrDuration!, $to: DateTimeOrDuration!) {
  projectUpdates(first: 100, after: $after, includeArchived: true, orderBy: updatedAt,
    filter: { updatedAt: { gte: $from, lte: $to } }) {
    nodes { id body url slugId health createdAt updatedAt archivedAt editedAt reactionData
      project { id } user { id }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const linear_projectUpdatesRaw = rawTable({ database: 'default', name: 'linear_project_updates_raw' })

export async function* readProjectUpdates(context: ReadContext<TimestampRange, TimestampWindowState>, deps: LinearClientDeps) {
  for await (const page of readLinearPages(context, {
    query, select: (data) => data.projectUpdates, label: 'project updates', window: context.selection,
    variables: { from: context.selection.from.toISOString(), to: context.selection.to.toISOString() },
  }, deps)) yield { rows: rawRows(page.items, linearId) }
}
