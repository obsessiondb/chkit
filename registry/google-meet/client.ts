import { HttpError, IngestConfigError, paginate, type ErrorClassifier, type FetchContext } from '@chkit/plugin-ingest'

import { googleMeetConfig, type GoogleMeetReaderConfig } from './config.js'

export interface Named { name: string; [key: string]: unknown }
export interface CollectionCursor { pageToken?: string; recoveryCount?: number }
interface CollectionOptions { filter?: string; initial?: CollectionCursor; pageSize?: number }

export interface GoogleMeetClientDeps {
  config: GoogleMeetReaderConfig
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
}

export const defaultGoogleMeetClientDeps: GoogleMeetClientDeps = {
  config: googleMeetConfig,
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.GOOGLE_MEET_ACCESS_TOKEN,
}

export const classifyGoogleMeetError: ErrorClassifier = (cause) =>
  cause instanceof IngestConfigError || cause instanceof SyntaxError ? { kind: 'permanent' } : undefined

export function readCollection(context: FetchContext, path: string, field: string, deps: GoogleMeetClientDeps, options: CollectionOptions = {}) {
  return paginate<Named, CollectionCursor, { reset: true }>({
    context, initial: options.initial ?? {}, label: `GET ${field}`,
    fetchPage: async (cursor, signal) => {
      const current = cursor ?? {}
      const page = await requestPage(path, field, current.pageToken, options.filter, options.pageSize ?? 100, signal, deps)
      if ('reset' in page) {
        if (current.recoveryCount) throw new IngestConfigError(`Meet ${field} repeatedly rejected its page token. Increase the execution budget or migrate the checkpoint after reviewing coverage.`)
        return { items: [], next: { recoveryCount: 1 }, metadata: { reset: true } }
      }
      return { items: page.items, next: page.nextPageToken ? { ...current, pageToken: page.nextPageToken } : undefined }
    },
  })
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new IngestConfigError(`Meet ${field} must be a non-empty string.`)
  return value
}

export function optionalTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, field)
}

export function timestamp(value: unknown, field: string): string {
  const result = optionalString(value, field)
  if (!result || !Number.isFinite(Date.parse(result))) throw new IngestConfigError(`Meet ${field} is not a timestamp.`)
  return result
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function requestPage(path: string, field: string, pageToken: string | undefined, filter: string | undefined, pageSize: number, signal: AbortSignal, deps: GoogleMeetClientDeps): Promise<{ items: Named[]; nextPageToken?: string } | { reset: true }> {
  const token = deps.token()?.trim()
  if (!token) throw new IngestConfigError('Set GOOGLE_MEET_ACCESS_TOKEN.')
  const url = new URL(`https://meet.googleapis.com/v2/${path}`)
  url.searchParams.set('pageSize', String(pageSize))
  if (filter) url.searchParams.set('filter', filter)
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  const response = await deps.fetch(url.toString(), { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { Authorization: `Bearer ${token}` }, redirect: 'error' })
  if (pageToken && (response.status === 400 || response.status === 410)) {
    const detail = await response.clone().text()
    if (/page[_\s-]*token/i.test(detail) && /invalid|expir/i.test(detail)) return { reset: true }
  }
  if (!response.ok) throw await HttpError.fromResponse(response)
  const payload: unknown = await response.json()
  if (!isObject(payload) || payload[field] !== undefined && !Array.isArray(payload[field])) throw new IngestConfigError(`Meet ${field} is not an array.`)
  const values = payload[field] ?? []
  if (!Array.isArray(values) || values.length > pageSize) throw new IngestConfigError(`Meet ${field} exceeded the requested page size.`)
  const items = values.map((value: unknown): Named => {
    if (!isObject(value)) throw new IngestConfigError('Meet returned an invalid resource.')
    const name = optionalString(value.name, 'resource name')
    if (!name || (field === 'conferenceRecords' ? !/^conferenceRecords\/[^/?#]+$/.test(name) : !name.startsWith(`${path}/`) || name.slice(path.length + 1).includes('/') || /[?#]/.test(name))) throw new IngestConfigError(`Meet ${field} returned a resource outside its requested parent.`)
    return { ...value, name }
  })
  return { items, nextPageToken: optionalString(payload.nextPageToken, 'nextPageToken') }
}
