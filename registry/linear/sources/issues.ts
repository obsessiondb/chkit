import { rawRows, rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { createLinearClient, type LinearClient, type LinearNode } from '../client.js'
import type { LinearConfig } from '../config.js'
import { linearId } from './common.js'

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

const labelNode = z.looseObject({ name: z.string().refine((value) => value.trim() !== '', 'must not be blank') })

export const linear_issuesRaw = rawTable({ database: 'default', name: 'linear_issues_raw' })

export async function* readIssues(context: ReadContext<TimestampRange, TimestampWindowState>, config: LinearConfig) {
  const client = createLinearClient(context, config)
  for await (const page of client.connection({
    query, path: ['issues'], label: 'issues', window: context.selection,
    variables: { from: context.selection.from.toISOString(), to: context.selection.to.toISOString() },
  })) {
    for (const issue of page.items) {
      const labels = await completeLabels(client, issue)
      yield { rows: rawRows([{ ...issue, labels }], linearId) }
    }
  }
}

/** Label names are the explicitly requested projection; consume every label page first. */
async function completeLabels(client: LinearClient, issue: LinearNode): Promise<string[]> {
  const first = client.inline(issue.labels, 'issue labels')
  const labels = first.items.map(labelName)
  if (first.next !== undefined) {
    for await (const page of client.connection({
      query: labelsQuery, path: ['issue', 'labels'], variables: { id: linearId(issue) }, initial: first.next, label: 'issue labels',
    })) labels.push(...page.items.map(labelName))
  }
  return labels
}

function labelName(label: LinearNode): string {
  return labelNode.parse(label).name
}
