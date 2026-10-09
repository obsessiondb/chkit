import { IngestConfigError, paginate, rawRows, rawTable, type Page, type ReadContext } from '@chkit/plugin-ingest'

import { isObject, optionalString, requestEvents, requiredString, resolveCalendar, type CalendarEvent, type GoogleCalendarClientDeps } from '../client.js'
import { googleCalendarConfig, type GoogleCalendarReaderConfig } from '../config.js'

export interface CalendarState {
  scope: string
  calendarId: string
  syncToken?: string
  pageToken?: string
  /** Recovery attempts for this unfinished sync, including previous executions. */
  recoveryCount?: number
}

interface CalendarPageMetadata { checkpoint: CalendarState; id?: 'calendar-reset' | 'calendar-empty-page' }

export const google_calendar_eventsRaw = rawTable({ database: googleCalendarConfig.database, name: 'google_calendar_events_raw' })

// Candidate page state is acknowledged with its rows, including empty terminal pages.
export async function* readEvents(context: ReadContext<CalendarState | undefined, CalendarState>, deps: GoogleCalendarClientDeps) {
  const scope = calendarScope(deps.config)
  const sourceId = deps.config.sourceId
  const resolvedCalendarId = await resolveCalendar(context, deps)
  if (context.state && context.state.calendarId !== resolvedCalendarId) {
    throw new IngestConfigError('Calendar checkpoint belongs to a different authenticated calendar. Use a separate stream ID for the new source.')
  }
  const pages = paginate({
    context, initial: context.state ?? { scope, calendarId: resolvedCalendarId }, label: 'GET calendar events',
    fetchPage: async (cursor = { scope, calendarId: resolvedCalendarId }, signal): Promise<Page<CalendarEvent, CalendarState, CalendarPageMetadata>> => {
      const page = await requestEvents(cursor, signal, deps)
      if ('reset' in page) {
        if ((cursor.recoveryCount ?? 0) >= 1) throw new IngestConfigError('Calendar unfinished sync repeatedly rejected a token across resumed runs. Adjust the editable stream chunk budget, run duration, or polling frequency, then explicitly migrate the saved state or use a new stream identity after reviewing coverage.')
        // Reset debt distinguishes safe replay from cycling, and survives restarts.
        const checkpoint: CalendarState = { scope, calendarId: resolvedCalendarId, recoveryCount: 1, ...(page.reset === 'page' && cursor.syncToken ? { syncToken: cursor.syncToken } : {}) }
        return { items: [], next: checkpoint, metadata: { checkpoint, id: 'calendar-reset' } }
      }
      // Retain the input token on every continuation; only the terminal
      // checkpoint promotes nextSyncToken and clears recovery debt.
      const checkpoint: CalendarState = page.nextPageToken
        ? { ...cursor, pageToken: page.nextPageToken }
        : { scope, calendarId: resolvedCalendarId, syncToken: requiredString(page.nextSyncToken, 'nextSyncToken') }
      return { items: page.items, next: page.nextPageToken ? checkpoint : undefined,
        metadata: { checkpoint, ...(page.items.length === 0 ? { id: 'calendar-empty-page' } : {}) } }
    },
  })
  for await (const page of pages) {
    if (!page.metadata) throw new IngestConfigError('Calendar page has no checkpoint metadata.')
    yield { rows: rawRows(page.items, (event) => JSON.stringify([sourceId, resolvedCalendarId, event.id])),
      state: page.metadata.checkpoint, id: page.metadata.id }
  }
}

export function parseCalendarState(raw: unknown, config: GoogleCalendarReaderConfig): CalendarState {
  const scope = calendarScope(config)
  if (!isObject(raw) || raw.scope !== scope) throw new IngestConfigError('Calendar checkpoint scope changed. Migrate the state explicitly or use a new stream ID.')
  if (raw.recoveryCount !== undefined && raw.recoveryCount !== 0 && raw.recoveryCount !== 1) throw new IngestConfigError('Calendar checkpoint recoveryCount must be zero or one.')
  return { scope, calendarId: requiredString(raw.calendarId, 'checkpoint calendar id'), syncToken: optionalString(raw.syncToken, 'checkpoint syncToken'), pageToken: optionalString(raw.pageToken, 'checkpoint pageToken'), recoveryCount: raw.recoveryCount }
}

function calendarScope(config: GoogleCalendarReaderConfig): string {
  return JSON.stringify([config.sourceId, config.calendarId, { singleEvents: false, showDeleted: true, maxResults: 250 }])
}
