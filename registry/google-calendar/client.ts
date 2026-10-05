import { HttpError, IngestConfigError, type ErrorClassifier, type FetchContext } from '@chkit/plugin-ingest'

import { googleCalendarConfig, type GoogleCalendarReaderConfig } from './config.js'
import type { CalendarState } from './sources/events.js'

export interface CalendarEvent { id: string; [key: string]: unknown }
interface Page { items: CalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }

export interface GoogleCalendarClientDeps {
  config: GoogleCalendarReaderConfig
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
}

export const defaultGoogleCalendarClientDeps: GoogleCalendarClientDeps = {
  config: googleCalendarConfig,
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.GOOGLE_CALENDAR_ACCESS_TOKEN,
}

export const classifyGoogleCalendarError: ErrorClassifier = (cause) =>
  cause instanceof IngestConfigError || cause instanceof SyntaxError ? { kind: 'permanent' } : undefined

export async function resolveCalendar(context: FetchContext, deps: GoogleCalendarClientDeps): Promise<string> {
  return context.attempt(async (signal) => {
    const payload = await request(`calendars/${encodeURIComponent(deps.config.calendarId)}`, signal, deps)
    return requiredString(payload.id, 'calendar id')
  }, { label: 'GET calendar metadata' })
}

/** paginate owns the single executor attempt around this page request. */
export async function requestEvents(state: CalendarState, signal: AbortSignal, deps: GoogleCalendarClientDeps): Promise<Page | { reset: 'sync' | 'page' }> {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(state.calendarId)}/events`)
  for (const [key, value] of Object.entries({ singleEvents: 'false', showDeleted: 'true', maxResults: '250' })) url.searchParams.set(key, value)
  if (state.syncToken) url.searchParams.set('syncToken', state.syncToken)
  if (state.pageToken) url.searchParams.set('pageToken', state.pageToken)
  const response = await deps.fetch(url.toString(), { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: authorization(deps), redirect: 'error' })
  if (response.status === 410 && state.syncToken) return { reset: 'sync' }
  if ((response.status === 400 || response.status === 410) && state.pageToken) return { reset: 'page' }
  if (!response.ok) throw await HttpError.fromResponse(response)
  const payload: unknown = await response.json()
  if (!isObject(payload) || (payload.items !== undefined && !Array.isArray(payload.items))) throw new IngestConfigError('Calendar items are not an array.')
  const items = (payload.items ?? []).map((item: unknown) => {
    if (!isObject(item)) throw new IngestConfigError('Calendar returned an invalid event.')
    return { ...item, id: requiredString(item.id, 'event id') }
  })
  const nextPageToken = optionalString(payload.nextPageToken, 'nextPageToken')
  const nextSyncToken = optionalString(payload.nextSyncToken, 'nextSyncToken')
  if (nextPageToken && nextSyncToken) throw new IngestConfigError('Calendar returned both a page and sync token.')
  if (!nextPageToken && !nextSyncToken) throw new IngestConfigError('Calendar terminal page has no nextSyncToken.')
  return { items, nextPageToken, nextSyncToken }
}

async function request(path: string, signal: AbortSignal, deps: GoogleCalendarClientDeps): Promise<Record<string, unknown>> {
  const response = await deps.fetch(`https://www.googleapis.com/calendar/v3/${path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: authorization(deps), redirect: 'error' })
  if (!response.ok) throw await HttpError.fromResponse(response)
  const payload: unknown = await response.json()
  if (!isObject(payload)) throw new IngestConfigError('Calendar returned an invalid response.')
  return payload
}

function authorization(deps: GoogleCalendarClientDeps): Record<string, string> {
  const token = deps.token()?.trim()
  if (!token) throw new IngestConfigError('Set GOOGLE_CALENDAR_ACCESS_TOKEN.')
  return { Authorization: `Bearer ${token}` }
}

export function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field)
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new IngestConfigError(`Calendar ${field} must be a non-empty string.`)
  return value
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
