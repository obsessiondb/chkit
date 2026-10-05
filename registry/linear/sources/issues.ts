import { IngestConfigError, rawRows, rawTable, type FetchContext, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { requireLinearObject, type LinearClientDeps, type LinearObject } from '../client.js'
import { linearConnection, linearId, readLinearPages } from './common.js'

const query = `query Issues($after: String, $from: DateTimeOrDuration!, $to: DateTimeOrDuration!) {
  issues(first: 100, after: $after, includeArchived: true, orderBy: updatedAt,
    filter: { updatedAt: { gte: $from, lte: $to } }) {
    nodes { id identifier number title description url branchName createdAt updatedAt archivedAt
      startedAt completedAt canceledAt dueDate estimate priority sortOrder subIssueSortOrder
      team { id } state { id name type color } assignee { id } creator { id }
      project { id } cycle { id } parent { id }
      labels(first: 20, includeArchived: true) { nodes { id name } pageInfo { hasNextPage endCursor } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`
const labelsQuery = `query IssueLabels($id: String!, $after: String) {
  issue(id: $id) { labels(first: 100, after: $after, includeArchived: true) {
    nodes { id name } pageInfo { hasNextPage endCursor }
  } }
}`

export const linear_issuesRaw = rawTable({ database: 'default', name: 'linear_issues_raw' })

export async function* readIssues(context: ReadContext<TimestampRange, TimestampWindowState>, deps: LinearClientDeps) {
  for await (const page of readLinearPages(context, {
    query, select: (data) => data.issues, label: 'issues', window: context.selection,
    variables: { from: context.selection.from.toISOString(), to: context.selection.to.toISOString() },
  }, deps)) {
    for (const issue of page.items) {
      const labels = await completeLabels(context, issue, deps)
      yield { rows: rawRows([{ ...issue, labels }], linearId) }
    }
  }
}

/** Label names are the explicitly requested projection; consume every label page first. */
async function completeLabels(context: FetchContext, issue: LinearObject, deps: LinearClientDeps): Promise<string[]> {
  const first = linearConnection(issue.labels, undefined, 'issue labels')
  const labels = first.items.map(labelName)
  if (first.next !== undefined) {
    for await (const page of readLinearPages(context, {
      query: labelsQuery, variables: { id: linearId(issue) }, initial: first.next, label: 'issue labels',
      select: (data) => requireLinearObject(data.issue, 'label parent issue').labels,
    }, deps)) labels.push(...page.items.map(labelName))
  }
  return labels
}

function labelName(label: LinearObject): string {
  if (typeof label.name !== 'string' || !label.name.trim()) throw new IngestConfigError('Linear label has no name.')
  return label.name
}
