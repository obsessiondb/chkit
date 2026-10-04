import { cursorState, definePipeline, defineStream, HttpError, IngestConfigError, rawRows, rawTable, type FetchContext } from '@chkit/plugin-ingest'

const database = 'default'
// Keep this identity tied to one OAuth installation. Use another stream ID for another source.
const sourceId = 'google-calendar.primary'
const calendarId = 'primary'
const scope = JSON.stringify([sourceId, calendarId, { singleEvents: false, showDeleted: true, maxResults: 250 }])

interface Event { id: string; [key: string]: unknown }
interface Page { items: Event[]; nextPageToken?: string; nextSyncToken?: string }
interface CalendarState {
  scope: string
  calendarId: string
  syncToken?: string
  pageToken?: string
  /** Recovery attempts for this unfinished sync, including previous executions. */
  recoveryCount?: number
}

export const google_calendar_eventsRaw = rawTable({ database, name: 'google_calendar_events_raw' })

export const google_calendarPipeline = definePipeline({
  id: 'google-calendar', tags: ['provider:google-calendar'], maxFetches: 1,
  streams: [defineStream({
    id: 'google-calendar.events', tags: ['resource:events'], destination: google_calendar_eventsRaw,
    incremental: {
      ...cursorState<CalendarState>({ id: 'google-calendar.sync-token', version: 1, parse: parseState }),
      plan({ state, range }) {
        if (range?.from || range?.to) throw new IngestConfigError('Calendar canonical sync does not accept date bounds. Use a separate bounded instances reader for an occurrence backfill.')
        return state
      },
    },
    batchSize: 1,
    budget: { maxChunks: 200, maxChunkRows: 250 },
    classifyError: (cause) => cause instanceof IngestConfigError ? { kind: 'permanent' } : undefined,
    async *read(context) {
      const resolvedCalendarId = await resolveCalendar(context)
      if (context.state && context.state.calendarId !== resolvedCalendarId) {
        throw new IngestConfigError('Calendar checkpoint belongs to a different authenticated calendar. Use a separate stream ID for the new source.')
      }
      let state: CalendarState = context.state ?? { scope, calendarId: resolvedCalendarId }
      const seen = new Set<string>()
      if (state.pageToken) seen.add(state.pageToken)
      while (true) {
        const page = await readPage(context, state)
        if ('reset' in page) {
          if ((state.recoveryCount ?? 0) >= 1) throw new IngestConfigError('Calendar unfinished sync repeatedly rejected a token across resumed runs. Adjust the editable stream chunk budget, run duration, or polling frequency, then explicitly migrate the saved state or use a new stream identity after reviewing coverage.')
          seen.clear()
          // An expired sync token starts a new baseline; a rejected page token
          // replays the current sync from its original, committed input token.
          state = { scope, calendarId: resolvedCalendarId, recoveryCount: (state.recoveryCount ?? 0) + 1, ...(page.reset === 'page' && state.syncToken ? { syncToken: state.syncToken } : {}) }
          yield { rows: [], state, id: 'calendar-reset' }
          continue
        }
        if (page.nextPageToken && seen.has(page.nextPageToken)) throw new IngestConfigError('Calendar repeated a page token.')
        if (page.nextPageToken) seen.add(page.nextPageToken)
        state = page.nextPageToken
          ? { ...state, pageToken: page.nextPageToken }
          // Only acknowledgement of this terminal page clears recovery debt.
          : { scope, calendarId: resolvedCalendarId, syncToken: requiredString(page.nextSyncToken, 'nextSyncToken') }
        const rows = rawRows(page.items, (event) => JSON.stringify([sourceId, resolvedCalendarId, event.id]))
        // Empty terminal pages must commit the new sync token too.
        yield { rows, state, ...(rows.length === 0 ? { id: 'calendar-empty-page' } : {}) }
        if (!page.nextPageToken) return
      }
    },
  })],
})

async function resolveCalendar(context: FetchContext): Promise<string> {
  return context.attempt(async (signal) => {
    const payload = await request(`calendars/${encodeURIComponent(calendarId)}`, signal)
    return requiredString(payload.id, 'calendar id')
  }, { label: 'GET calendar metadata' })
}

async function readPage(context: FetchContext, state: CalendarState): Promise<Page | { reset: 'sync' | 'page' }> {
  return context.attempt(async (signal) => {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(state.calendarId)}/events`)
    for (const [key, value] of Object.entries({ singleEvents: 'false', showDeleted: 'true', maxResults: '250' })) url.searchParams.set(key, value)
    if (state.syncToken) url.searchParams.set('syncToken', state.syncToken)
    if (state.pageToken) url.searchParams.set('pageToken', state.pageToken)
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: authorization(), redirect: 'error' })
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
  }, { label: 'GET calendar events' })
}

async function request(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: authorization(), redirect: 'error' })
  if (!response.ok) throw await HttpError.fromResponse(response)
  const payload: unknown = await response.json()
  if (!isObject(payload)) throw new IngestConfigError('Calendar returned an invalid response.')
  return payload
}

function parseState(raw: unknown): CalendarState {
  if (!isObject(raw) || raw.scope !== scope) throw new IngestConfigError('Calendar checkpoint scope changed. Migrate the state explicitly or use a new stream ID.')
  if (raw.recoveryCount !== undefined && raw.recoveryCount !== 0 && raw.recoveryCount !== 1) throw new IngestConfigError('Calendar checkpoint recoveryCount must be zero or one.')
  return { scope, calendarId: requiredString(raw.calendarId, 'checkpoint calendar id'), syncToken: optionalString(raw.syncToken, 'checkpoint syncToken'), pageToken: optionalString(raw.pageToken, 'checkpoint pageToken'), recoveryCount: raw.recoveryCount }
}

function authorization(): Record<string, string> {
  const token = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN?.trim()
  if (!token) throw new IngestConfigError('Set GOOGLE_CALENDAR_ACCESS_TOKEN.')
  return { Authorization: `Bearer ${token}` }
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new IngestConfigError(`Calendar ${field} must be a non-empty string.`)
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
