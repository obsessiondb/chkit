import { IngestConfigError, paginate, rawRows, rawTable, type FetchContext, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { graphql, type LinearClientDeps } from '../client.js'

const query = `query Issues($after: String, $from: DateTimeOrDuration!, $to: DateTimeOrDuration!) {
  issues(first: 100, after: $after, includeArchived: true, orderBy: updatedAt,
    filter: { updatedAt: { gte: $from, lte: $to } }) {
    nodes { id identifier title description url createdAt updatedAt archivedAt completedAt canceledAt
      team { id key name } state { name type } assignee { id name email }
      comments(first: 20, includeArchived: true) { nodes { id body createdAt updatedAt } pageInfo { hasNextPage endCursor } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`
const commentsQuery = `query IssueComments($id: String!, $after: String) {
  issue(id: $id) { comments(first: 100, after: $after, includeArchived: true) {
    nodes { id body createdAt updatedAt } pageInfo { hasNextPage endCursor }
  } }
}`
interface Connection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
interface Issue { id: string; updatedAt: string; comments: Connection<Record<string, unknown>>; [key: string]: unknown }
interface ResponseBody { data?: { issues: Connection<Issue> }; errors?: { message: string }[] }
interface CommentsBody { data?: { issue: { comments: Connection<Record<string, unknown>> } | null }; errors?: { message: string }[] }

export const linear_issuesRaw = rawTable({ database: 'default', name: 'linear_issues_raw' })

export async function* readIssues(context: ReadContext<TimestampRange, TimestampWindowState>, deps: LinearClientDeps) {
  const pages = paginate<Issue, string>({
    context, label: 'POST /graphql issues',
    fetchPage: async (after, signal) => {
      const body = await graphql<ResponseBody>(query, {
        after: after ?? null, from: context.selection.from.toISOString(), to: context.selection.to.toISOString(),
      }, signal, deps)
      if (body.errors?.length || !body.data?.issues) throw new IngestConfigError(`Linear query failed: ${body.errors?.map((item) => item.message).join('; ') ?? 'missing issues'}`)
      const page = validateConnection(body.data.issues)
      return { items: page.nodes, next: continuation(page, after, 'issue') }
    },
  })
  for await (const page of pages) {
    for (const issue of page) {
      if (!issue.id || !Number.isFinite(Date.parse(issue.updatedAt))) throw new IngestConfigError('Linear issue has no ID or valid updatedAt.')
      const comments = await completeComments(context, issue, deps)
      yield { rows: rawRows([{ ...issue, comments }], (item) => item.id) }
    }
  }
}

async function completeComments(context: FetchContext, issue: Issue, deps: LinearClientDeps): Promise<Connection<Record<string, unknown>>> {
  let page = validateConnection(issue.comments)
  const nodes = [...page.nodes]
  const initial = continuation(page, undefined, 'comment')
  if (initial !== undefined) {
    for await (const items of paginate<Record<string, unknown>, string>({
      context, initial, label: 'POST /graphql issue comments',
      fetchPage: async (after, signal) => {
        const body = await graphql<CommentsBody>(commentsQuery, { id: issue.id, after }, signal, deps)
        if (body.errors?.length || !body.data?.issue) throw new IngestConfigError('Linear comment query failed; the issue window is incomplete.')
        page = validateConnection(body.data.issue.comments)
        return { items: page.nodes, next: continuation(page, after, 'comment') }
      },
    })) nodes.push(...items)
  }
  // Preserve the provider connection shape, with the terminal continuation information.
  return { ...issue.comments, nodes, pageInfo: page.pageInfo }
}

function continuation<T>(page: Connection<T>, current: string | undefined, resource: string): string | undefined {
  if (!page.pageInfo.hasNextPage) return undefined
  const cursor = page.pageInfo.endCursor
  if (typeof cursor !== 'string' || !cursor.trim() || cursor === current) throw new IngestConfigError(`Linear returned no new ${resource} cursor.`)
  return cursor
}

function validateConnection<T>(value: Connection<T>): Connection<T> {
  if (!value || !Array.isArray(value.nodes) || !value.pageInfo || typeof value.pageInfo.hasNextPage !== 'boolean') {
    throw new IngestConfigError('Linear returned an invalid connection.')
  }
  return value
}
