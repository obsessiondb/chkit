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

type CalendarPageMetadata = CalendarState | { reset: 'sync' | 'page' }

export const google_calendar_eventsRaw = rawTable({ database: googleCalendarConfig.database, name: 'google_calendar_events_raw' })

// Candidate page state is acknowledged with its rows, including empty terminal pages.
export async function* readEvents(context: ReadContext<CalendarState | undefined, CalendarState>, deps: GoogleCalendarClientDeps) {
  const scope = calendarScope(deps.config)
  const sourceId = deps.config.sourceId
  const resolvedCalendarId = await resolveCalendar(context, deps)
  if (context.state && context.state.calendarId !== resolvedCalendarId) {
    throw new IngestConfigError('Calendar checkpoint belongs to a different authenticated calendar. Use a separate stream ID for the new source.')
  }
  let state: CalendarState = context.state ?? { scope, calendarId: resolvedCalendarId }
  while (true) {
    let reset: 'sync' | 'page' | undefined
    const pages = paginate({
      context, initial: state, label: 'GET calendar events',
      fetchPage: async (cursor = state, signal): Promise<Page<CalendarEvent, CalendarState, CalendarPageMetadata>> => {
        const page = await requestEvents(cursor, signal, deps)
        if ('reset' in page) return { items: [], next: undefined, metadata: page }
        // Keep the input sync token throughout pagination; only the terminal
        // candidate promotes nextSyncToken and clears acknowledged recovery debt.
        const candidate: CalendarState = page.nextPageToken
          ? { ...cursor, pageToken: page.nextPageToken }
          : { scope, calendarId: resolvedCalendarId, syncToken: requiredString(page.nextSyncToken, 'nextSyncToken') }
        return { items: page.items, next: page.nextPageToken ? candidate : undefined, metadata: candidate }
      },
    })
    for await (const page of pages) {
      if (!page.metadata) throw new IngestConfigError('Calendar page has no checkpoint metadata.')
      if ('reset' in page.metadata) {
        reset = page.metadata.reset
        break
      }
      state = page.metadata
      const rows = rawRows(page.items, (event) => JSON.stringify([sourceId, resolvedCalendarId, event.id]))
      // Empty terminal pages must commit the new sync token too.
      yield { rows, state, ...(rows.length === 0 ? { id: 'calendar-empty-page' } : {}) }
    }
    if (!reset) return
    if ((state.recoveryCount ?? 0) >= 1) throw new IngestConfigError('Calendar unfinished sync repeatedly rejected a token across resumed runs. Adjust the editable stream chunk budget, run duration, or polling frequency, then explicitly migrate the saved state or use a new stream identity after reviewing coverage.')
    // Page rejection replays from the original input token; sync rejection
    // starts a new baseline. The reset remains checkpointed across executions.
    state = { scope, calendarId: resolvedCalendarId, recoveryCount: (state.recoveryCount ?? 0) + 1, ...(reset === 'page' && state.syncToken ? { syncToken: state.syncToken } : {}) }
    yield { rows: [], state, id: 'calendar-reset' }
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
