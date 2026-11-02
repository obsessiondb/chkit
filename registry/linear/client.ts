import { HttpError, paginate, type ErrorClassifier, type Page, type SourceContext, type TimestampRange } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { linearConfigSchema, type LinearConfig } from './config.js'

export type LinearNode = z.infer<typeof linearNode>
export type LinearSettings = Omit<z.output<typeof linearConfigSchema>, 'apiKey'>

export interface ConnectionRequest {
  query: string
  path: readonly string[]
  label: string
  variables?: Record<string, unknown>
  initial?: string
  window?: TimestampRange
}

export interface LinearClient {
  settings: LinearSettings
  connection(request: ConnectionRequest): AsyncGenerator<Page<LinearNode, string>>
  inline(value: unknown, label: string): Page<LinearNode, string>
}

interface GraphqlReply {
  body: unknown
  response: Response
}

const nonBlank = z.string().refine((value) => value.trim() !== '', 'must not be blank')
const linearNode = z.looseObject({ id: nonBlank })
const linearObject = z.looseObject({})
const connection = z.looseObject({
  nodes: z.array(linearNode),
  pageInfo: z.looseObject({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
})
const windowedNode = z.looseObject({ updatedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), 'must be a timestamp') })
const graphqlErrors = z.looseObject({ errors: z.array(z.unknown()).min(1) })
const graphqlResponse = z.looseObject({
  data: linearObject.nullish(),
  errors: z.array(z.looseObject({ extensions: z.looseObject({ code: z.unknown() }).nullish() })).optional(),
})

export function createLinearClient(context: SourceContext, config: LinearConfig): LinearClient {
  const { apiKey, ...settings } = linearConfigSchema.parse(config)
  const graphql = async (query: string, variables: Record<string, unknown>) => {
    const reply = await post(context, apiKey, JSON.stringify({ query, variables }))
    return graphqlData(reply)
  }
  return {
    settings,
    connection: (request) => paginate<LinearNode, string>({
      context, initial: request.initial, label: `POST /graphql ${request.label}`,
      fetchPage: async (after) => {
        const data = await graphql(request.query, { ...request.variables, after: after ?? null })
        const page = linearConnection(request.path.reduce<unknown>((value, field) => linearObject.parse(value)[field], data), request.label)
        if (request.window) assertWindow(page.items, request.window, request.label)
        return page
      },
    }),
    inline: linearConnection,
  }
}

export function classifyLinearError(cause: unknown): ReturnType<ErrorClassifier> {
  if (!(cause instanceof HttpError) || cause.status !== 429) return undefined
  const headers = cause.response.headers
  const resets = ['requests', 'endpoint-requests', 'complexity'].flatMap((kind) => {
    if (headers.get(`x-ratelimit-${kind}-remaining`) !== '0') return []
    const reset = Number(headers.get(`x-ratelimit-${kind}-reset`))
    return Number.isFinite(reset) && reset > 0 ? [Math.max(0, reset - Date.now())] : []
  })
  return { kind: 'rate_limited', retryAfterMs: cause.retryAfterMs ?? (resets.length ? Math.max(...resets) : undefined) }
}

async function post(context: SourceContext, apiKey: string, body: string): Promise<GraphqlReply> {
  try {
    const response = await context.fetch('https://api.linear.app/graphql', {
      method: 'POST', redirect: 'error', body,
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    })
    return { body: await response.json(), response }
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 400) throw error
    const reply: unknown = await error.response.json().catch(() => undefined)
    if (!graphqlErrors.safeParse(reply).success) throw error
    return { body: reply, response: error.response }
  }
}

async function graphqlData(reply: GraphqlReply): Promise<Record<string, unknown>> {
  const { data, errors } = graphqlResponse.parse(reply.body)
  if (errors?.some((error) => error.extensions?.code === 'RATELIMITED')) {
    throw HttpError.withStatus(reply.response, 429, { body: JSON.stringify(reply.body) })
  }
  if (errors?.length) throw new Error(`Linear GraphQL returned errors: ${JSON.stringify(errors)}`)
  if (!data) throw new Error('Linear GraphQL returned no data.')
  return data
}

function linearConnection(value: unknown, label: string): Page<LinearNode, string> {
  const { nodes, pageInfo } = connection.parse(value)
  if (!pageInfo.hasNextPage) return { items: nodes, next: undefined }
  if (!pageInfo.endCursor?.trim()) throw new Error(`Linear ${label} returned no new cursor.`)
  return { items: nodes, next: pageInfo.endCursor }
}

function assertWindow(items: readonly LinearNode[], window: TimestampRange, label: string): void {
  for (const item of items) {
    const updated = Date.parse(windowedNode.parse(item).updatedAt)
    if (updated < window.from.getTime() || updated > window.to.getTime()) {
      throw new Error(`Linear ${label} has no updatedAt within the requested window.`)
    }
  }
}
