import { rawRows, rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import type { LinearClientDeps } from '../client.js'
import { linearId, readLinearPages } from './common.js'

const query = `query Comments($after: String, $from: DateTimeOrDuration!, $to: DateTimeOrDuration!) {
  comments(first: 100, after: $after, includeArchived: true, orderBy: updatedAt,
    filter: { updatedAt: { gte: $from, lte: $to } }) {
    nodes { id body url createdAt updatedAt archivedAt editedAt resolvedAt quotedText reactionData
      issueId projectUpdateId documentContentId initiativeUpdateId projectId initiativeId
      parentId resolvingCommentId user { id } externalUser { id } resolvingUser { id }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const linear_commentsRaw = rawTable({ database: 'default', name: 'linear_comments_raw' })

export async function* readComments(context: ReadContext<TimestampRange, TimestampWindowState>, deps: LinearClientDeps) {
  for await (const page of readLinearPages(context, {
    query, select: (data) => data.comments, label: 'comments', window: context.selection,
    variables: { from: context.selection.from.toISOString(), to: context.selection.to.toISOString() },
  }, deps)) yield { rows: rawRows(page.items, linearId) }
}
