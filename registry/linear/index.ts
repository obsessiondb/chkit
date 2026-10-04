import { definePipeline, defineStream, HttpError, IngestConfigError, rawRows, rawTable, timestampWindow, type ErrorClassifier, type FetchContext, type TimestampRange } from '@chkit/plugin-ingest'

const database = 'default'
// Keep stream IDs and destinations tied to one Linear workspace; use new ones when switching accounts.
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

export const linear_issuesRaw = rawTable({ database, name: 'linear_issues_raw' })

export const linearPipeline = definePipeline({
  id: 'linear', tags: ['provider:linear'], maxStreams: 1, maxFetches: 1,
  streams: [defineStream({
    id: 'linear.issues', tags: ['resource:issues'], destination: linear_issuesRaw,
    // Newest-first pages cannot advance a safe watermark until the whole window loads.
    incremental: timestampWindow({ start: new Date(0), overlapMs: 5 * 60 * 1000 }),
    classifyError: classifyLinearError,
    async *read(context) {
      let after: string | null = null
      const seen = new Set<string>()
      while (true) {
        const issues = await readPage(context, after, context.selection)
        for (const issue of issues.nodes) {
          if (!issue.id || !Number.isFinite(Date.parse(issue.updatedAt))) throw new IngestConfigError('Linear issue has no ID or valid updatedAt.')
          const comments = await completeComments(context, issue)
          yield { rows: rawRows([{ ...issue, comments }], (item) => item.id) }
        }
        if (!issues.pageInfo.hasNextPage) return
        after = continuation(issues.pageInfo.endCursor, seen, 'issue')
      }
    },
  })],
})

/** Linear reports GraphQL rate exhaustion as HTTP 400 rather than 429. */
function classifyLinearError(cause: unknown): ReturnType<ErrorClassifier> {
  if (!(cause instanceof HttpError) || cause.status !== 400 || !/"code"\s*:\s*"RATELIMITED"/.test(cause.body)) return undefined
  const headers = cause.response.headers
  const resets = ['requests', 'endpoint-requests', 'complexity'].flatMap((kind) => {
    if (headers.get(`x-ratelimit-${kind}-remaining`) !== '0') return []
    const reset = Number(headers.get(`x-ratelimit-${kind}-reset`))
    return Number.isFinite(reset) && reset > 0 ? [Math.max(0, reset - Date.now())] : []
  })
  return { kind: 'rate_limited', retryAfterMs: cause.retryAfterMs ?? (resets.length ? Math.max(...resets) : undefined) }
}

async function readPage(context: FetchContext, after: string | null, window: TimestampRange): Promise<Connection<Issue>> {
  const body = await graphql<ResponseBody>(context, query, { after, from: window.from.toISOString(), to: window.to.toISOString() }, 'issues')
  if (body.errors?.length || !body.data?.issues) throw new IngestConfigError(`Linear query failed: ${body.errors?.map((item) => item.message).join('; ') ?? 'missing issues'}`)
  return validateConnection(body.data.issues)
}

async function completeComments(context: FetchContext, issue: Issue): Promise<Connection<Record<string, unknown>>> {
  let page = validateConnection(issue.comments)
  const nodes = [...page.nodes]
  const seen = new Set<string>()
  while (page.pageInfo.hasNextPage) {
    const after = continuation(page.pageInfo.endCursor, seen, 'comment')
    const body = await graphql<CommentsBody>(context, commentsQuery, { id: issue.id, after }, 'issue comments')
    if (body.errors?.length || !body.data?.issue) throw new IngestConfigError('Linear comment query failed; the issue window is incomplete.')
    page = validateConnection(body.data.issue.comments)
    nodes.push(...page.nodes)
  }
  // Preserve the provider connection shape, with the terminal continuation information.
  return { ...issue.comments, nodes, pageInfo: page.pageInfo }
}

async function graphql<T>(context: FetchContext, document: string, variables: Record<string, unknown>, label: string): Promise<T> {
  return context.attempt(async (signal) => {
    const token = process.env.LINEAR_API_KEY?.trim()
    if (!token) throw new IngestConfigError('Set LINEAR_API_KEY.')
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: document, variables }),
    })
    if (!response.ok) throw await HttpError.fromResponse(response)
    return await response.json() as T
  }, { label: `POST /graphql ${label}` })
}

function continuation(cursor: string | null, seen: Set<string>, resource: string): string {
  if (typeof cursor !== 'string' || !cursor.trim() || seen.has(cursor)) throw new IngestConfigError(`Linear returned no new ${resource} cursor.`)
  seen.add(cursor)
  return cursor
}

function validateConnection<T>(value: Connection<T>): Connection<T> {
  if (!value || !Array.isArray(value.nodes) || !value.pageInfo || typeof value.pageInfo.hasNextPage !== 'boolean') {
    throw new IngestConfigError('Linear returned an invalid connection.')
  }
  return value
}
