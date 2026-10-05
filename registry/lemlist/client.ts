import { HttpError, IngestConfigError, paginate, type FetchContext, type TimestampRange } from '@chkit/plugin-ingest'

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

/** Offsets are traversal positions, never durable change cursors. */
export function readPages(
  context: FetchContext,
  resource: 'activities' | 'campaigns',
  window: TimestampRange | undefined,
  deps: LemlistClientDeps,
) {
  const seen = new Set<string>()
  return paginate({
    context, initial: 0, label: `GET /${resource}`,
    fetchPage: async (offset = 0, signal) => {
      const items = await requestPage(resource, offset, window, signal, deps)
      // Increasing offsets do not detect a provider that ignores them and repeats its payload.
      if (items.length > 0) {
        const identity = JSON.stringify(items.map((item) => item._id))
        if (seen.has(identity)) throw new IngestConfigError(`Lemlist ${resource} repeated a page.`)
        seen.add(identity)
      }
      const next = items.length === deps.config.pageSize ? offset + items.length : undefined
      if (next !== undefined && !Number.isSafeInteger(next)) throw new IngestConfigError('Lemlist offset exceeded the safe integer range.')
      return { items, next }
    },
  })
}

async function requestPage(
  resource: 'activities' | 'campaigns',
  offset: number,
  window: TimestampRange | undefined,
  signal: AbortSignal,
  deps: LemlistClientDeps,
): Promise<LemlistItem[]> {
  const key = deps.token()?.trim()
  if (!key) throw new IngestConfigError('Set LEMLIST_API_KEY.')
  const url = new URL(`https://api.lemlist.com/api/${resource}`)
  url.searchParams.set('version', 'v2')
  url.searchParams.set('limit', String(deps.config.pageSize))
  url.searchParams.set('offset', String(offset))
  if (window) {
    url.searchParams.set('minDate', window.from.toISOString())
    url.searchParams.set('maxDate', window.to.toISOString())
  } else {
    url.searchParams.set('sortBy', 'createdAt')
    url.searchParams.set('sortOrder', 'asc')
  }
  const response = await deps.fetch(url.toString(), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    headers: { Authorization: `Basic ${Buffer.from(`:${key}`).toString('base64')}` },
  })
  if (!response.ok) throw await HttpError.fromResponse(response)
  const result: unknown = await response.json()
  const items = resource === 'campaigns' && isObject(result) ? result.campaigns : result
  if (!Array.isArray(items) || !items.every(isItem) || items.length > deps.config.pageSize) {
    throw new IngestConfigError(`Lemlist ${resource} response has no valid items or exceeds pageSize.`)
  }
  return items
}

function isItem(value: unknown): value is LemlistItem {
  return isObject(value) && typeof value._id === 'string' && value._id.length > 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
