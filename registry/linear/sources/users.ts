import { rawRows, rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import type { LinearClientDeps } from '../client.js'
import { linearId, readLinearPages } from './common.js'

const query = `query Users($after: String, $from: DateTimeOrDuration!, $to: DateTimeOrDuration!) {
  users(first: 100, after: $after, includeArchived: true, includeDisabled: true, orderBy: updatedAt,
    filter: { updatedAt: { gte: $from, lte: $to } }) {
    nodes { id name displayName email description title avatarUrl url timezone
      active admin owner guest app disableReason createdAt updatedAt archivedAt organization { id }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const linear_usersRaw = rawTable({ database: 'default', name: 'linear_users_raw' })

export async function* readUsers(context: ReadContext<TimestampRange, TimestampWindowState>, deps: LinearClientDeps) {
  for await (const page of readLinearPages(context, {
    query, select: (data) => data.users, label: 'users', window: context.selection,
    variables: { from: context.selection.from.toISOString(), to: context.selection.to.toISOString() },
  }, deps)) yield { rows: rawRows(page, linearId) }
}
