import { IngestConfigError, rawRows, rawTable, type ReadContext } from '@chkit/plugin-ingest'

import { isObject, optionalString, readPage, requiredString, resolveCalendar, type GoogleCalendarClientDeps } from '../client.js'
import { googleCalendarConfig, type GoogleCalendarReaderConfig } from '../config.js'

export interface CalendarState {
  scope: string
  calendarId: string
  syncToken?: string
  pageToken?: string
  /** Recovery attempts for this unfinished sync, including previous executions. */
  recoveryCount?: number
}

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
  const seen = new Set<string>()
  if (state.pageToken) seen.add(state.pageToken)
  while (true) {
    const page = await readPage(context, state, deps)
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
