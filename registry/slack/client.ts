
import { HttpError, paginate, type Page, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { slackReaderConfigSchema, type SlackReaderConfig } from './config.js'

export type MessageMethod = 'conversations.history' | 'conversations.replies'
interface CollectionMetadata { hasMore: boolean; cursorExpired?: true }
type CollectionPages<TItem> = AsyncGenerator<Page<TItem, string, CollectionMetadata>, void, void>
export type SlackSettings = Omit<z.output<typeof slackReaderConfigSchema>, 'token'>

export interface SlackClient {
  settings: SlackSettings
  workspace(): Promise<string>
  conversations(): CollectionPages<SlackEntity>
  users(): CollectionPages<SlackEntity>
  messages(method: MessageMethod, query: Record<string, string>): CollectionPages<SlackMessage>
}

type Method = 'auth.test' | 'conversations.list' | 'users.list' | MessageMethod
type Call = (method: Method, query: Record<string, string>) => Promise<SlackPayload>

interface CollectionRequest<TItem> {
  method: Exclude<Method, 'auth.test'>
  field: 'channels' | 'members' | 'messages'
  item: z.ZodType<TItem>
  limit: number
  query?: Record<string, string>
  boundary?: (items: readonly TItem[], hasMore: boolean) => boolean
}

const slackId = z.string().refine((value) => value.trim() !== '', 'must not be blank')
const slackTs = z.string().regex(/^\d+\.\d+$/, 'must be an unmodified decimal timestamp string')
const slackEntity = z.looseObject({ id: slackId })
const slackMessage = z.looseObject({ ts: slackTs, thread_ts: slackTs.optional(), reply_count: z.int().min(0).optional() })
const workspace = z.looseObject({ team_id: slackId })
const envelope = z.looseObject({ ok: z.boolean(), error: z.string().optional(), needed: z.string().optional() })
const pageEnvelope = z.looseObject({
  has_more: z.boolean().optional(),
  response_metadata: z.looseObject({ next_cursor: z.string().nullish() }).optional(),
})
const transientErrors = new Set(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])

export type SlackEntity = z.infer<typeof slackEntity>
export type SlackMessage = z.infer<typeof slackMessage>
type SlackPayload = z.infer<typeof envelope>

export function createSlackClient(context: SourceContext, config: SlackReaderConfig): SlackClient {
  const { token, ...settings } = slackReaderConfigSchema.parse(config)
  const call: Call = async (method, query) => {
    const url = new URL(`https://slack.com/api/${method}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const response = await context.fetch(url, {
      method: method === 'auth.test' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
    })
    return readPayload(method, response)
  }
  return {
    settings,
    workspace: () => context.attempt(async () => workspace.parse(await call('auth.test', {})).team_id, { label: 'POST /api/auth.test' }),
    conversations: () => selectConversations(readCollection(context, call, {
      method: 'conversations.list', field: 'channels', item: slackEntity, limit: settings.pageSize,
      query: { types: settings.conversationTypes.join(','), exclude_archived: 'false' },
    }), settings.channels),
    users: () => readCollection(context, call, { method: 'users.list', field: 'members', item: slackEntity, limit: settings.pageSize }),
    messages: (method, query) => readCollection(context, call, {
      method, field: 'messages', item: slackMessage, limit: settings.messagePageSize, query,
      boundary: (items, hasMore) => !hasMore || items.some((item) => method !== 'conversations.replies' || item.ts !== query.ts),
    }),
  }
}

function readCollection<TItem>(context: SourceContext, call: Call, request: CollectionRequest<TItem>): CollectionPages<TItem> {
  return paginate({
    context, label: `GET /api/${request.method}`,
    fetchPage: async (cursor: string | undefined): Promise<Page<TItem, string, CollectionMetadata>> => {
      const payload = await call(request.method, { ...request.query, limit: String(request.limit), ...(cursor ? { cursor } : {}) })
      if (payload.error === 'invalid_cursor') {
        if (!request.boundary) throw new Error(`Slack ${request.method} pagination cursor expired.`)
        return { items: [], next: undefined, metadata: { hasMore: false, cursorExpired: true } }
      }
      const page = pageEnvelope.parse(payload)
      const items = z.array(request.item).parse(payload[request.field])
      const next = page.response_metadata?.next_cursor?.trim() ?? ''
      const metadata = { hasMore: page.has_more === true || next.length > 0 }
      if (!request.boundary) {
        if (page.has_more === true && !next) throw new Error(`Slack ${request.method} reports more data without a pagination cursor; refusing an incomplete scan.`)
        return { items, next: next || undefined, metadata }
      }
      if (request.boundary(items, metadata.hasMore)) return { items, next: undefined, metadata }
      if (!next) throw new Error('Slack empty page did not provide a new continuation.')
      return { items, next, metadata }
    },
  })
}

async function* selectConversations(pages: CollectionPages<SlackEntity>, selected: readonly string[] | undefined): CollectionPages<SlackEntity> {
  const missing = new Set(selected)
  for await (const page of pages) {
    const channels = selected === undefined ? page.items : page.items.filter((channel) => selected.includes(channel.id))
    for (const channel of channels) missing.delete(channel.id)
    yield { ...page, items: channels }
  }
  for (const id of missing) {
    throw new Error(`Configured Slack channel "${id}" was not found or is not accessible for conversationTypes.`)
  }
}

async function readPayload(method: Method, response: Response): Promise<SlackPayload> {
  const payload = envelope.parse(await response.json())
  if (payload.ok || payload.error === 'invalid_cursor') return payload
  const code = payload.error ?? 'unknown_error'
  if (code === 'ratelimited' || code === 'rate_limited') throw HttpError.withStatus(response, 429, { body: JSON.stringify({ error: code }), retryAfterMs: 60_000 })
  if (transientErrors.has(code)) throw HttpError.withStatus(response, 503, { body: JSON.stringify({ error: code }) })
  const needed = payload.needed ? ` Required scopes: ${payload.needed}.` : ''
  const repliesHint = method === 'conversations.replies' ? ' Disable includeReplies explicitly for history-only reads.' : ''
  throw new Error(`Slack ${method} failed (${code}).${needed} Check the token, resource scopes, and conversation access.${repliesHint}`)
}
