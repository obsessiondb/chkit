import { HttpError, IngestConfigError, paginate, rawRows, type ErrorClassifier, type FetchContext } from '@chkit/plugin-ingest'

import { circlebackConfig, type CirclebackReaderConfig } from './config.js'

const baseUrl = 'https://circleback.ai/api'
export type CirclebackObject = Record<string, unknown>

export interface CirclebackClientDeps {
  config: CirclebackReaderConfig
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
}

export const defaultCirclebackClientDeps: CirclebackClientDeps = {
  config: circlebackConfig,
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.CIRCLEBACK_API_KEY,
}

/** The executor owns one request attempt per page; Link cursors remain local to the full read. */
export function readCirclebackPages(context: FetchContext, collection: {
  path: '/meetings' | '/action-items' | '/people' | '/companies'
  query?: Record<string, string>
}, deps: CirclebackClientDeps) {
  const initial = new URL(`${baseUrl}${collection.path}`)
  for (const [key, value] of Object.entries(collection.query ?? {})) initial.searchParams.set(key, value)
  return paginate<CirclebackObject, string>({
    context, initial: initial.toString(), label: `GET ${collection.path}`,
    fetchPage: async (url, signal) => {
      if (!url) throw new IngestConfigError('Circleback collection URL is missing.')
      const response = await requestCircleback(url, signal, deps)
      const body: unknown = await response.json()
      if (!Array.isArray(body)) throw new IngestConfigError(`Circleback ${collection.path} is not an array.`)
      return { items: body.map((item: unknown) => requireCirclebackObject(item, collection.path)),
        next: nextLink(response.headers.get('link'), url, collection.query ?? {}) }
    },
  })
}

export async function requestCircleback(pathOrUrl: string, signal: AbortSignal, deps: CirclebackClientDeps, allowUnavailable = false): Promise<Response> {
  const token = deps.token()?.trim()
  if (!token) throw new IngestConfigError('Set CIRCLEBACK_API_KEY.')
  const response = await deps.fetch(pathOrUrl.startsWith('/') ? `${baseUrl}${pathOrUrl}` : pathOrUrl, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (allowUnavailable && (response.status === 403 || response.status === 404)) return response
  if (!response.ok) throw await HttpError.fromResponse(response)
  return response
}

export function classifyCirclebackError(cause: unknown): ReturnType<ErrorClassifier> {
  return cause instanceof SyntaxError ? { kind: 'permanent' } : undefined
}

export function toCirclebackRows(items: readonly CirclebackObject[], id: (item: CirclebackObject) => string | number, sourceId: string) {
  return rawRows(items.map((data) => ({ source_id: sourceId, data })), (item) => JSON.stringify([sourceId, id(item.data)]))
}

/** Tag names are the requested projection; provider objects otherwise stay intact. */
export function tagNames(item: CirclebackObject): CirclebackObject {
  if (item.tags === undefined) return item
  if (!Array.isArray(item.tags)) throw new IngestConfigError('Circleback tags is not an array.')
  return { ...item, tags: item.tags.map((tag: unknown) => {
    const name = requireCirclebackObject(tag, 'tag').name
    if (typeof name !== 'string' || !name.trim()) throw new IngestConfigError('Circleback tag has no name.')
    return name
  }) }
}

export function requireCirclebackObject(value: unknown, label: string): CirclebackObject {
  if (!isCirclebackObject(value)) throw new IngestConfigError(`Circleback ${label} is not an object.`)
  return value
}

export function meetingId(item: CirclebackObject): string {
  if (typeof item.id !== 'string' || !item.id.trim()) throw new IngestConfigError('Circleback meeting has no valid ID.')
  return item.id
}

export function numericId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new IngestConfigError(`Circleback ${label} has no valid numeric ID.`)
  return value
}

function isCirclebackObject(value: unknown): value is CirclebackObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nextLink(header: string | null, current: string, query: Record<string, string>): string | undefined {
  if (!header?.trim()) return undefined
  const candidates: string[] = []
  for (const part of header.split(/,(?=\s*<)/)) {
    const link = /^\s*<([^>]+)>\s*(.*)$/.exec(part)
    if (!link) throw new IngestConfigError('Circleback returned a malformed Link header.')
    const relation = /;\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/.exec(link[2] ?? '')
    if (!(relation?.[1] ?? relation?.[2])?.split(/\s+/).includes('next')) continue
    if (!link[1]) throw new IngestConfigError('Circleback next page URL is missing.')
    candidates.push(link[1])
  }
  if (candidates.length > 1) throw new IngestConfigError('Circleback returned multiple next pages.')
  const value = candidates[0]
  if (!value) return undefined
  let next: URL
  try { next = new URL(value, current) }
  catch { throw new IngestConfigError('Circleback returned an invalid next page URL.') }
  if (next.origin !== 'https://circleback.ai' || next.pathname !== new URL(current).pathname || next.username || next.password || next.hash) {
    throw new IngestConfigError('Circleback next page changed the collection or origin.')
  }
  for (const [key, value] of Object.entries(query)) {
    const values = next.searchParams.getAll(key)
    if (values.length > 1 || values.some((nextValue) => nextValue !== value)) {
      throw new IngestConfigError(`Circleback next page changed the ${key} filter.`)
    }
    next.searchParams.set(key, value)
  }
  if (next.toString() === current) throw new IngestConfigError('Circleback next page made no progress.')
  return next.toString()
}
