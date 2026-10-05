import { HttpError, IngestConfigError, type ErrorClassifier, type FetchContext } from '@chkit/plugin-ingest'

import { googleMeetConfig, type GoogleMeetReaderConfig } from './config.js'

export interface Named { name: string; [key: string]: unknown }
interface Page { items: Named[]; nextPageToken?: string }

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

export async function readPage(context: FetchContext, path: string, field: string, pageToken: string | undefined, filter: string | undefined, deps: GoogleMeetClientDeps): Promise<Page | { reset: true }> {
  return context.attempt(async (signal) => {
    const token = deps.token()?.trim()
    if (!token) throw new IngestConfigError('Set GOOGLE_MEET_ACCESS_TOKEN.')
    const url = new URL(`https://meet.googleapis.com/v2/${path}`)
    url.searchParams.set('pageSize', '100')
    if (filter) url.searchParams.set('filter', filter)
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const response = await deps.fetch(url.toString(), { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { Authorization: `Bearer ${token}` }, redirect: 'error' })
    // Replaying the same fixed collection is safe. A second rejection fails visibly.
    if (pageToken && (response.status === 400 || response.status === 410)) return { reset: true }
    if (!response.ok) throw await HttpError.fromResponse(response)
    const payload: unknown = await response.json()
    if (!isObject(payload) || (payload[field] !== undefined && !Array.isArray(payload[field]))) throw new IngestConfigError(`Meet ${field} is not an array.`)
    const values = payload[field] ?? []
    if (!Array.isArray(values)) throw new IngestConfigError(`Meet ${field} is not an array.`)
    if (values.length > 100) throw new IngestConfigError(`Meet ${field} exceeded the requested page size.`)
    const items = values.map((item: unknown) => named(item))
    if (items.some((item) => field === 'conferenceRecords'
      ? !/^conferenceRecords\/[^/]+$/.test(item.name)
      : !item.name.startsWith(`${path}/`) || item.name.slice(path.length + 1).includes('/'))) {
      throw new IngestConfigError(`Meet ${field} returned a resource outside its requested parent.`)
    }
    const nextPageToken = optionalString(payload.nextPageToken, 'nextPageToken')
    return { items, nextPageToken }
  }, { label: `GET ${field}` })
}

export function named(value: unknown): Named {
  if (!isObject(value)) throw new IngestConfigError('Meet returned an invalid resource.')
  const name = requiredString(value.name, 'resource name')
  if (!/^conferenceRecords\/[^/?#]+(?:\/transcripts\/[^/?#]+(?:\/entries\/[^/?#]+)?)?$/.test(name)) throw new IngestConfigError('Meet returned an invalid resource name.')
  return { ...value, name }
}

export function optionalTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, field)
}

export function timestamp(value: unknown, field: string): string {
  const result = requiredString(value, field)
  if (!Number.isFinite(Date.parse(result))) throw new IngestConfigError(`Meet ${field} is not a timestamp.`)
  return result
}

export function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field)
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new IngestConfigError(`Meet ${field} must be a non-empty string.`)
  return value
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
