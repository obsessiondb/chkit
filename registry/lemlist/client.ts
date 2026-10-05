import { HttpError, IngestConfigError, paginate, rawRows, type FetchContext, type TimestampRange } from '@chkit/plugin-ingest'

import { lemlistConfig, type LemlistReaderConfig } from './config.js'

interface LemlistItem { _id: string; [key: string]: unknown }

export interface LemlistClientDeps {
  config: LemlistReaderConfig
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
}

export const defaultLemlistClientDeps: LemlistClientDeps = {
  config: lemlistConfig,
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.LEMLIST_API_KEY,
}

/** Offsets are local traversal positions, never durable change cursors. */
export function readPages(
  context: FetchContext,
  resource: 'activities' | 'campaigns' | 'contacts' | 'companies',
  window: TimestampRange | undefined,
  deps: LemlistClientDeps,
) {
  const seen = new Set<string>()
  return paginate({
    context, initial: 0, label: `GET /${resource}`,
    fetchPage: async (offset = 0, signal) => {
      const params: Record<string, string> = { limit: String(deps.config.pageSize), offset: String(offset) }
      if (resource === 'activities' || resource === 'campaigns') params.version = 'v2'
      if (window) {
        params.minDate = window.from.toISOString()
        params.maxDate = window.to.toISOString()
      } else if (resource !== 'contacts') {
        params.sortBy = 'createdAt'
        params.sortOrder = 'asc'
      }
      const result = await requestLemlist(`/${resource}`, params, signal, deps)
      let items: LemlistItem[]
      let next: number | undefined
      if (resource === 'contacts' || resource === 'companies') {
        const response = requireObject(result, `${resource} listing`)
        items = requireItems(response.data, resource)
        const limit = requireInteger(response.limit, 'listing limit', 1)
        const total = requireInteger(response.total, 'listing total')
        if (response.offset !== offset || limit > deps.config.pageSize || items.length > limit ||
          offset + items.length > total || (items.length < limit && offset + items.length < total)) {
          throw new IngestConfigError(`Lemlist ${resource} has inconsistent pagination; replay this stream.`)
        }
        next = offset + items.length < total ? offset + limit : undefined
      } else {
        // The public API returns arrays; retain compatibility with older campaign envelopes.
        items = requireItems(resource === 'campaigns' && isObject(result) ? result.campaigns : result, resource)
        if (items.length > deps.config.pageSize) throw new IngestConfigError(`Lemlist ${resource} exceeds pageSize.`)
        next = items.length === deps.config.pageSize ? offset + items.length : undefined
      }
      rejectRepeatedPage(items, seen, resource)
      if (next !== undefined && !Number.isSafeInteger(next)) throw new IngestConfigError('Lemlist offset exceeded the safe integer range.')
      return { items, next }
    },
  })
}

/** Inbox pagination is page-based; the messages endpoint accepts the equivalent skip. */
export function readInboxPages(context: FetchContext, scope: { userId: string } | { contactId: string }, deps: LemlistClientDeps) {
  const path = 'userId' in scope ? '/inbox' : `/inbox/${encodeURIComponent(scope.contactId)}`
  const seen = new Set<string>()
  let expectedTotal: number | undefined
  let received = 0
  return paginate({
    context, initial: { page: 1, skip: 0 }, label: `GET ${path}`,
    fetchPage: async (cursor = { page: 1, skip: 0 }, signal) => {
      const params: Record<string, string> = { limit: String(deps.config.pageSize) }
      if ('userId' in scope) {
        params.userId = scope.userId
        params.page = String(cursor.page)
      } else {
        params.skip = String(cursor.skip)
        params.markAsRead = 'false'
      }
      const response = requireObject(await requestLemlist(path, params, signal, deps), 'inbox listing')
      const items = requireItems(response.data, path)
      const pagination = requireObject(response.pagination, 'inbox pagination')
      const total = requireInteger(pagination.totalItems, 'inbox totalItems')
      const perPage = requireInteger(pagination.perPage, 'inbox perPage', 1)
      const currentPage = requireInteger(pagination.currentPage, 'inbox currentPage', 1)
      const totalPages = requireInteger(pagination.totalPages, 'inbox totalPages')
      const nextPage = pagination.nextPage
      if (currentPage !== cursor.page || perPage > deps.config.pageSize || items.length > perPage ||
        (expectedTotal !== undefined && total !== expectedTotal) ||
        (nextPage !== null && (!Number.isSafeInteger(nextPage) || nextPage !== currentPage + 1)) ||
        (nextPage !== null && (items.length === 0 || currentPage >= totalPages)) ||
        (nextPage === null && totalPages > currentPage)) {
        throw new IngestConfigError('Lemlist inbox has malformed or incomplete pagination; replay this stream.')
      }
      rejectRepeatedPage(items, seen, path)
      const count = received + items.length
      if (count > total || (nextPage === null && count !== total)) throw new IngestConfigError('Lemlist inbox ended before its advertised complete collection.')
      expectedTotal = total
      received = count
      const next = typeof nextPage === 'number' ? { page: nextPage, skip: cursor.skip + perPage } : undefined
      return { items, next }
    },
  })
}

export async function requestLemlist(path: string, params: Record<string, string>, signal: AbortSignal, deps: LemlistClientDeps): Promise<unknown> {
  const key = deps.token()?.trim()
  if (!key) throw new IngestConfigError('Set LEMLIST_API_KEY.')
  const url = new URL(`https://api.lemlist.com/api${path}`)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  const response = await deps.fetch(url.toString(), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    headers: { Authorization: `Basic ${Buffer.from(`:${key}`).toString('base64')}` },
  })
  if (!response.ok) throw await HttpError.fromResponse(response)
  try {
    return await response.json()
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new IngestConfigError(`Lemlist ${path} returned invalid JSON.`)
    throw cause
  }
}

export function toLemlistRows(items: readonly LemlistItem[], deps: LemlistClientDeps, parent?: { campaign_id: string } | { contact_id: string } | { user_id: string }) {
  return rawRows(items.map((data) => ({ source_id: deps.config.sourceId, ...parent, data })), ({ data }) =>
    JSON.stringify([deps.config.sourceId, ...Object.values(parent ?? {}), data._id]))
}

export function requireItems(value: unknown, label: string): LemlistItem[] {
  if (!Array.isArray(value) || !value.every(isItem)) throw new IngestConfigError(`Lemlist ${label} response has no valid items.`)
  const ids = value.map((item) => item._id)
  if (new Set(ids).size !== ids.length) throw new IngestConfigError(`Lemlist ${label} repeated an object ID.`)
  return value
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new IngestConfigError(`Lemlist ${label} is not an object.`)
  return value
}

export function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new IngestConfigError(`Lemlist ${label} has no valid ID.`)
  return value
}

function rejectRepeatedPage(items: readonly LemlistItem[], seen: Set<string>, label: string) {
  if (items.some((item) => seen.has(item._id))) throw new IngestConfigError(`Lemlist ${label} repeated a page or object ID; replay this stream.`)
  for (const item of items) seen.add(item._id)
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new IngestConfigError(`Lemlist ${label} is invalid.`)
  return value
}

function isItem(value: unknown): value is LemlistItem {
  return isObject(value) && typeof value._id === 'string' && value._id.trim().length > 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
