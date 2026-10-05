import { rawRows, rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import type { LinearClientDeps } from '../client.js'
import { linearId, readLinearPages } from './common.js'

const query = `query Projects($after: String, $from: DateTimeOrDuration!, $to: DateTimeOrDuration!) {
  projects(first: 100, after: $after, includeArchived: true, orderBy: updatedAt,
    filter: { updatedAt: { gte: $from, lte: $to } }) {
    nodes { id name description content url slugId icon color createdAt updatedAt archivedAt
      startDate startDateResolution targetDate targetDateResolution startedAt completedAt canceledAt
      priority sortOrder lead { id } creator { id } status { id name type color }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const linear_projectsRaw = rawTable({ database: 'default', name: 'linear_projects_raw' })

export async function* readProjects(context: ReadContext<TimestampRange, TimestampWindowState>, deps: LinearClientDeps) {
  for await (const page of readLinearPages(context, {
    query, select: (data) => data.projects, label: 'projects', window: context.selection,
    variables: { from: context.selection.from.toISOString(), to: context.selection.to.toISOString() },
  }, deps)) yield { rows: rawRows(page.items, linearId) }
}
