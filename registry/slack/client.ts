import { setTimeout as sleep } from 'node:timers/promises'

import { HttpError, IngestConfigError, rawRows, type ErrorClassifier, type FetchContext } from '@chkit/plugin-ingest'

import { slackConfig } from './config.js'

export type SlackEntity = Record<string, unknown>

export interface SlackClientDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export interface CollectionRequest {
  method: 'conversations.list' | 'users.list' | 'conversations.history' | 'conversations.replies'
  field: 'channels' | 'members' | 'messages'
  idField: 'id' | 'ts'
  query?: Record<string, string>
  pageSize?: number
}

const defaultDeps: SlackClientDeps = {
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.SLACK_API_TOKEN,
  wait: async (milliseconds, signal) => { await sleep(milliseconds, undefined, { signal }) },
}

/** Each page is validated inside attempt, so executor retry/cancellation owns every request. */
export async function* readCollection(
  context: FetchContext,
  request: CollectionRequest,
  deps: SlackClientDeps = defaultDeps,
): AsyncGenerator<SlackEntity[]> {
  const messageRequest = request.field === 'messages'
  const limit = request.pageSize ?? (messageRequest ? slackConfig.messagePageSize : slackConfig.pageSize)
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit >= 1_000) {
    throw new IngestConfigError('Slack page sizes must be safe integers between 1 and 999.')
  }
  const seenCursors = new Set<string>()
  let cursor = ''
  while (true) {
    context.signal.throwIfAborted()
    const query = { ...request.query, limit: String(limit), ...(cursor ? { cursor } : {}) }
    const page = await context.attempt(async (signal) => {
      const payload = await requestSlack(request.method, query, signal, deps)
      return parsePage(payload, request)
    }, { label: `GET /api/${request.method}` })
    if (page.items.length > 0) yield page.items
    // Empty/short pages can still have a cursor. Only cursor exhaustion ends a scan.
    if (!page.cursor) return
    if (seenCursors.has(page.cursor)) throw new IngestConfigError(`Slack ${request.method} repeated a pagination cursor.`)
    seenCursors.add(page.cursor)
    cursor = page.cursor
  }
}

/** Discover independently in each reader; pipeline stream order is not a dependency. */
export async function discoverChannels(context: FetchContext, deps?: SlackClientDeps): Promise<SlackEntity[]> {
  const allowedTypes = ['public_channel', 'private_channel', 'im', 'mpim']
  if (slackConfig.conversationTypes.length === 0 || !slackConfig.conversationTypes.every((type) => allowedTypes.includes(type))) {
    throw new IngestConfigError('Slack conversationTypes must select public_channel, private_channel, im, or mpim.')
  }
  const channels: SlackEntity[] = []
  for await (const page of readCollection(context, {
    method: 'conversations.list', field: 'channels', idField: 'id',
    query: { types: slackConfig.conversationTypes.join(','), exclude_archived: 'false' },
  }, deps)) channels.push(...page)
  const selected = slackConfig.channels
  if (selected === undefined) return channels
  for (const id of selected) {
    if (!channels.some((channel) => entityId(channel, 'id') === id)) {
      throw new IngestConfigError(`Configured Slack channel "${id}" was not found or is not accessible for conversationTypes.`)
    }
  }
  return channels.filter((channel) => selected.includes(entityId(channel, 'id')))
}

/** Scope row identities to the authenticated workspace, never its mutable display name. */
export async function getWorkspace(context: FetchContext, deps: SlackClientDeps = defaultDeps): Promise<string> {
  return context.attempt(async (signal) => {
    const payload = await requestSlack('auth.test', {}, signal, deps)
    return entityId(payload, 'team_id')
  }, { label: 'POST /api/auth.test' })
}

/** Original fields stay under data; provider fields cannot overwrite envelope metadata. */
export function toSlackRows(
  items: readonly SlackEntity[],
  resource: string,
  teamId: string,
  idField: 'id' | 'ts',
  channelId?: string,
) {
  return rawRows(
    items.map((data) => ({
      source_id: slackConfig.sourceId, team_id: teamId,
      ...(channelId === undefined ? {} : { channel_id: channelId }), data,
    })),
    ({ data }) => JSON.stringify([
      slackConfig.sourceId, resource, teamId, ...(channelId === undefined ? [] : [channelId]), entityId(data, idField),
    ]),
  )
}

export function entityId(entity: SlackEntity, field: string): string {
  const value = entity[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IngestConfigError(`Slack entity is missing a valid ${field} string.`)
  }
  if (field === 'ts' && !/^\d+\.\d+$/.test(value)) {
    throw new IngestConfigError('Slack message ts must be an unmodified decimal timestamp string.')
  }
  return value
}

export const classifySlackError: ErrorClassifier = (cause) => {
  if (cause instanceof IngestConfigError || cause instanceof SyntaxError) return { kind: 'permanent' }
  // HTTP errors preserve Retry-After, server retries, and permanent 4xx semantics.
  return undefined
}

async function requestSlack(
  method: CollectionRequest['method'] | 'auth.test',
  query: Record<string, string>,
  signal: AbortSignal,
  deps: SlackClientDeps,
): Promise<Record<string, unknown>> {
  const token = deps.token()?.trim()
  if (!token) throw new IngestConfigError('Set SLACK_API_TOKEN before running Slack ingestion. Schema imports do not need credentials.')
  const interval = method === 'conversations.history' || method === 'conversations.replies'
    ? slackConfig.messageIntervalMs : slackConfig.requestIntervalMs
  if (!Number.isSafeInteger(interval) || interval < 0 || interval > 2_147_483_647) {
    throw new IngestConfigError('Slack request intervals must be non-negative safe integers within the timer range.')
  }
  await deps.wait(interval, signal)
  signal.throwIfAborted()
  const url = new URL(`https://slack.com/api/${method}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await deps.fetch(url.toString(), {
    method: method === 'auth.test' ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: 'error',
  })
  if (!response.ok) throw await HttpError.fromResponse(response)
  const payload: unknown = await response.json()
  if (!isObject(payload) || typeof payload.ok !== 'boolean') {
    throw new IngestConfigError(`Slack ${method} returned an invalid response envelope.`)
  }
  // Slack reports authentication, permission, and transient errors in HTTP 200 responses.
  if (!payload.ok) {
    const code = typeof payload.error === 'string' ? payload.error : 'unknown_error'
    if (code === 'ratelimited' || code === 'rate_limited') {
      const headers = new Headers(response.headers)
      if (!headers.has('Retry-After')) headers.set('Retry-After', '60')
      throw await HttpError.fromResponse(new Response(JSON.stringify({ error: code }), { status: 429, headers }))
    }
    if (['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'].includes(code)) {
      throw await HttpError.fromResponse(new Response(JSON.stringify({ error: code }), { status: 503 }))
    }
    const needed = typeof payload.needed === 'string' ? ` Required scopes: ${payload.needed}.` : ''
    const repliesHint = method === 'conversations.replies' ? ' Disable includeReplies explicitly for history-only reads.' : ''
    throw new IngestConfigError(`Slack ${method} failed (${code}).${needed} Check SLACK_API_TOKEN, resource scopes, and conversation access.${repliesHint}`)
  }
  return payload
}

function parsePage(payload: Record<string, unknown>, request: CollectionRequest) {
  const values = payload[request.field]
  if (!Array.isArray(values)) throw new IngestConfigError(`Slack ${request.method} returned no ${request.field} array.`)
  const items = values.map((value: unknown) => {
    if (!isObject(value)) throw new IngestConfigError(`Slack ${request.method} returned an invalid entity.`)
    entityId(value, request.idField)
    if (request.field === 'messages' && value.reply_count !== undefined
      && (typeof value.reply_count !== 'number' || !Number.isSafeInteger(value.reply_count) || value.reply_count < 0)) {
      throw new IngestConfigError(`Slack ${request.method} returned an invalid reply_count.`)
    }
    return value
  })
  const metadata = payload.response_metadata
  if (metadata !== undefined && !isObject(metadata)) {
    throw new IngestConfigError(`Slack ${request.method} returned invalid response_metadata.`)
  }
  const next = isObject(metadata) ? metadata.next_cursor : undefined
  if (next !== undefined && next !== null && typeof next !== 'string') {
    throw new IngestConfigError(`Slack ${request.method} returned an invalid next_cursor.`)
  }
  const cursor = typeof next === 'string' ? next.trim() : ''
  if (payload.has_more !== undefined && typeof payload.has_more !== 'boolean') {
    throw new IngestConfigError(`Slack ${request.method} returned an invalid has_more flag.`)
  }
  if (payload.has_more === true && !cursor) {
    throw new IngestConfigError(`Slack ${request.method} reports more data without a pagination cursor; refusing an incomplete scan.`)
  }
  return { items, cursor }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
