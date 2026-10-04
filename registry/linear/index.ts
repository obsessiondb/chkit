import { definePipeline, defineStream, HttpError, rawRows, rawTable, type FetchContext } from '@chkit/plugin-ingest'

const database = 'default'
const query = `query Issues($after: String) {
  issues(first: 100, after: $after) {
    nodes { id identifier title description url createdAt updatedAt completedAt canceledAt
      team { id key name } state { name type } assignee { id name email }
      comments(first: 100) { nodes { id body createdAt updatedAt } pageInfo { hasNextPage endCursor } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`
interface Issue { id: string; [key: string]: unknown }
interface ResponseBody { data?: { issues: { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }; errors?: { message: string }[] }

export const linear_issuesRaw = rawTable({ database, name: 'linear_issues_raw' })

export const linearPipeline = definePipeline({
  id: 'linear', tags: ['provider:linear'], maxFetches: 1,
  streams: [defineStream({ id: 'linear.issues', tags: ['resource:issues'], destination: linear_issuesRaw,
    async *read(context) {
      let after: string | null = null
      const seen = new Set<string>()
      while (true) {
        const body = await readPage(context, after)
        const issues = body.data?.issues
        if (body.errors?.length || !issues) throw new Error(`Linear query failed: ${body.errors?.map((item) => item.message).join('; ') ?? 'missing issues'}`)
        if (issues.nodes.length) yield { rows: rawRows(issues.nodes, (issue) => issue.id) }
        if (!issues.pageInfo.hasNextPage) return
        after = issues.pageInfo.endCursor
        if (!after || seen.has(after)) throw new Error('Linear returned no new issue cursor')
        seen.add(after)
      }
    },
  })],
})

async function readPage(context: FetchContext, after: string | null): Promise<ResponseBody> {
  return context.attempt(async (signal) => {
    const token = process.env.LINEAR_API_KEY
    if (!token) throw new Error('Set LINEAR_API_KEY')
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST', signal,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { after } }),
    })
    if (!response.ok) throw await HttpError.fromResponse(response)
    return await response.json() as ResponseBody
  }, { label: 'POST /graphql issues' })
}
