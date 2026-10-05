import { rawRows, rawTable, type ReadContext } from '@chkit/plugin-ingest'

import { requireLinearObject, type LinearClientDeps } from '../client.js'
import { linearId, readLinearPages } from './common.js'

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
export async function* readIssueHistory(context: ReadContext<undefined, undefined>, deps: LinearClientDeps) {
  for await (const parents of readLinearPages(context, {
    query: parentsQuery, select: (data) => data.issues, label: 'history parents',
  }, deps)) {
    for (const issue of parents.items) {
      for await (const page of readLinearPages(context, {
        query: historyQuery, variables: { id: linearId(issue) }, label: 'issue history',
        select: (data) => requireLinearObject(data.issue, 'history parent issue').history,
      }, deps)) yield { rows: rawRows(page.items, linearId) }
    }
  }
}
