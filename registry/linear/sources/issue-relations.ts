import { rawRows, rawTable, type ReadContext } from '@chkit/plugin-ingest'

import { createLinearClient } from '../client.js'
import type { LinearConfig } from '../config.js'
import { linearId } from './common.js'

const query = `query IssueRelations($after: String) {
  issueRelations(first: 100, after: $after, includeArchived: true, orderBy: updatedAt) {
    nodes { id type createdAt updatedAt archivedAt issue { id } relatedIssue { id } }
    pageInfo { hasNextPage endCursor }
  }
}`

export const linear_issueRelationsRaw = rawTable({ database: 'default', name: 'linear_issue_relations_raw' })

export async function* readIssueRelations(context: ReadContext<undefined, undefined>, config: LinearConfig) {
  const client = createLinearClient(context, config)
  for await (const page of client.connection({
    query, path: ['issueRelations'], label: 'issue relations',
  })) yield { rows: rawRows(page.items, linearId) }
}
