import { rawRows, rawTable, type ReadContext } from '@chkit/plugin-ingest'

import type { LinearClientDeps } from '../client.js'
import { linearId, readLinearPages } from './common.js'

const query = `query IssueRelations($after: String) {
  issueRelations(first: 100, after: $after, includeArchived: true, orderBy: updatedAt) {
    nodes { id type createdAt updatedAt archivedAt issue { id } relatedIssue { id } }
    pageInfo { hasNextPage endCursor }
  }
}`

export const linear_issueRelationsRaw = rawTable({ database: 'default', name: 'linear_issue_relations_raw' })

export async function* readIssueRelations(context: ReadContext<undefined, undefined>, deps: LinearClientDeps) {
  for await (const page of readLinearPages(context, {
    query, select: (data) => data.issueRelations, label: 'issue relations',
  }, deps)) yield { rows: rawRows(page.items, linearId) }
}
