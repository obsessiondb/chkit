import { HttpError, paginate, type Page, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { googleCalendarReaderConfigSchema, type GoogleCalendarReaderConfig } from './config.js'

export interface SyncCursor {
  syncToken?: string
  pageToken?: string
  /** Recovery attempts for this unfinished sync, including previous executions. */
  recoveryCount?: number
}
export interface EventsMetadata { reset?: true; nextSyncToken?: string }
export type CalendarEvent = z.infer<typeof calendarEvent>
export type GoogleCalendarSettings = Omit<z.output<typeof googleCalendarReaderConfigSchema>, 'accessToken'>

export interface GoogleCalendarClient {
  settings: GoogleCalendarSettings
  resolveCalendar(): Promise<string>
  events(calendarId: string, initial: SyncCursor): AsyncGenerator<Page<CalendarEvent, SyncCursor, EventsMetadata>>
}

type Get = (url: URL) => Promise<Response>
type EventsResponse = { items: CalendarEvent[] } & ({ nextPageToken: string } | { nextSyncToken: string })

const API = 'https://www.googleapis.com/calendar/v3'
const RATE_LIMIT_REASON = /"reason"\s*:\s*"(?:rateLimitExceeded|userRateLimitExceeded)"/
const nonBlank = z.string().refine((value) => value.trim() !== '', 'must not be blank')
const calendarEvent = z.looseObject({ id: nonBlank })
const calendarMetadata = z.looseObject({ id: nonBlank })
const eventsPage = z.looseObject({ items: z.array(calendarEvent).optional(), nextPageToken: nonBlank.optional(), nextSyncToken: nonBlank.optional() })

export function createGoogleCalendarClient(context: SourceContext, config: GoogleCalendarReaderConfig): GoogleCalendarClient {
  const { accessToken, ...settings } = googleCalendarReaderConfigSchema.parse(config)
  const get: Get = (url) => context.attempt(
    () => context.fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error' })
      .catch((error: unknown) => { throw asRateLimit(error) }),
    { label: `GET ${url.pathname}` },
  )
  return {
    settings,
    resolveCalendar: async () => {
      const response = await get(new URL(`${API}/calendars/${encodeURIComponent(settings.calendarId)}`))
      return calendarMetadata.parse(await response.json()).id
    },
    events: (calendarId, initial) => paginate<CalendarEvent, SyncCursor, EventsMetadata>({
      context, initial, label: 'GET calendar events',
      fetchPage: async (cursor = {}) => {
        const page = await requestEvents(get, calendarId, cursor)
        if ('reset' in page) {
          if ((cursor.recoveryCount ?? 0) >= 1) throw new Error('Calendar unfinished sync repeatedly rejected a token across resumed runs. Adjust the editable stream chunk budget, run duration, or polling frequency, then explicitly migrate the saved state or use a new stream identity after reviewing coverage.')
          // Reset debt distinguishes safe replay from cycling, and survives restarts.
          return { items: [], next: { recoveryCount: 1, ...(page.reset === 'page' && cursor.syncToken ? { syncToken: cursor.syncToken } : {}) }, metadata: { reset: true } }
        }
        return 'nextPageToken' in page
          ? { items: page.items, next: { ...cursor, pageToken: page.nextPageToken } }
          : { items: page.items, next: undefined, metadata: { nextSyncToken: page.nextSyncToken } }
      },
    }),
  }
}

/** Calendar reports exhausted quota as 403 with a rate-limit reason. */
function asRateLimit(error: unknown): unknown {
  return error instanceof HttpError && error.status === 403 && RATE_LIMIT_REASON.test(error.body) ? HttpError.withStatus(error.response, 429, { body: error.body }) : error
}

async function requestEvents(get: Get, calendarId: string, cursor: SyncCursor): Promise<EventsResponse | { reset: 'sync' | 'page' }> {
  const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`)
  for (const [key, value] of Object.entries({ singleEvents: 'false', showDeleted: 'true', maxResults: '250' })) url.searchParams.set(key, value)
  if (cursor.syncToken) url.searchParams.set('syncToken', cursor.syncToken)
  if (cursor.pageToken) url.searchParams.set('pageToken', cursor.pageToken)
  let response: Response
  try {
    response = await get(url)
  } catch (error) {
    const reset = rejectedToken(error, cursor)
    if (reset) return { reset }
    throw error
  }
  const { items = [], nextPageToken, nextSyncToken } = eventsPage.parse(await response.json())
  if (nextPageToken && nextSyncToken) throw new Error('Calendar returned both a page and sync token.')
  if (nextPageToken) return { items, nextPageToken }
  if (nextSyncToken) return { items, nextSyncToken }
  throw new Error('Calendar terminal page has no nextSyncToken.')
}

function rejectedToken(error: unknown, cursor: SyncCursor): 'sync' | 'page' | undefined {
  if (!(error instanceof HttpError)) return undefined
  if (error.status === 410 && cursor.syncToken) return 'sync'
  if ((error.status === 400 || error.status === 410) && cursor.pageToken) return 'page'
  return undefined
}
