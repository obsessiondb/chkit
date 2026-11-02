import { rawRows, rawTable, type ReadContext } from '@chkit/plugin-ingest'

import { createLinearClient } from '../client.js'
import type { LinearConfig } from '../config.js'
import { linearId } from './common.js'

const parentsQuery = `query IssueHistoryParents($after: String) {
  issues(first: 100, after: $after, includeArchived: true, orderBy: updatedAt) {
    nodes { id } pageInfo { hasNextPage endCursor }
  }
}`
const historyQuery = `query IssueHistory($id: String!, $after: String) {
  issue(id: $id) { history(first: 100, after: $after, includeArchived: true, orderBy: updatedAt) {
    nodes { id createdAt updatedAt archivedAt issue { id } actorId
      fromTitle toTitle updatedDescription fromAssigneeId toAssigneeId
      fromPriority toPriority fromEstimate toEstimate fromDueDate toDueDate
      fromTeamId toTeamId fromParentId toParentId fromStateId toStateId
      fromCycleId toCycleId fromProjectId toProjectId toConvertedProjectId
      addedLabelIds removedLabelIds archived trashed autoClosed autoArchived attachmentId
      fromSlaStartedAt toSlaStartedAt fromSlaBreachesAt toSlaBreachesAt
      fromSlaBreached toSlaBreached fromSlaType toSlaType
    }
    pageInfo { hasNextPage endCursor }
  } }
}`

export const linear_issueHistoryRaw = rawTable({ database: 'default', name: 'linear_issue_history_raw' })

/** Own complete parent discovery: old issues can gain history independently of other streams. */
export async function* readIssueHistory(context: ReadContext<undefined, undefined>, config: LinearConfig) {
  const client = createLinearClient(context, config)
  for await (const parents of client.connection({
    query: parentsQuery, path: ['issues'], label: 'history parents',
  })) {
    for (const issue of parents.items) {
      for await (const page of client.connection({
        query: historyQuery, path: ['issue', 'history'], variables: { id: linearId(issue) }, label: 'issue history',
      })) yield { rows: rawRows(page.items, linearId) }
    }
  }
}
