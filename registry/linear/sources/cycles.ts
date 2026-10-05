import { rawRows, rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import type { LinearClientDeps } from '../client.js'
import { linearId, readLinearPages } from './common.js'

const query = `query Cycles($after: String, $from: DateTimeOrDuration!, $to: DateTimeOrDuration!) {
  cycles(first: 100, after: $after, includeArchived: true, orderBy: updatedAt,
    filter: { updatedAt: { gte: $from, lte: $to } }) {
    nodes { id number name description startsAt endsAt completedAt autoArchivedAt
      createdAt updatedAt archivedAt team { id }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const linear_cyclesRaw = rawTable({ database: 'default', name: 'linear_cycles_raw' })

export async function* readCycles(context: ReadContext<TimestampRange, TimestampWindowState>, deps: LinearClientDeps) {
  for await (const page of readLinearPages(context, {
    query, select: (data) => data.cycles, label: 'cycles', window: context.selection,
    variables: { from: context.selection.from.toISOString(), to: context.selection.to.toISOString() },
  }, deps)) yield { rows: rawRows(page, linearId) }
}
