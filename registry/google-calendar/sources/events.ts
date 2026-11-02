import { rawRows, rawTable, type ReadContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { createGoogleCalendarClient, type SyncCursor } from '../client.js'
import { googleCalendarConfig, type GoogleCalendarReaderConfig } from '../config.js'

export interface CalendarState extends SyncCursor {
  scope: string
  calendarId: string
}

const nonBlank = z.string().refine((value) => value.trim() !== '', 'must not be blank')
const checkpointScope = z.looseObject({ scope: z.string() })
const checkpointSchema = z.strictObject({
  scope: z.string(),
  calendarId: nonBlank,
  syncToken: nonBlank.optional(),
  pageToken: nonBlank.optional(),
  recoveryCount: z.union([z.literal(0), z.literal(1)]).optional(),
})

export const google_calendar_eventsRaw = rawTable({ database: googleCalendarConfig.database, name: 'google_calendar_events_raw' })

// Candidate page state is acknowledged with its rows, including empty terminal pages.
export async function* readEvents(context: ReadContext<CalendarState | undefined, CalendarState>, config: GoogleCalendarReaderConfig) {
  const client = createGoogleCalendarClient(context, config)
  const scope = calendarScope(client.settings)
  const calendarId = await client.resolveCalendar()
  if (context.state && context.state.calendarId !== calendarId) {
    throw new Error('Calendar checkpoint belongs to a different authenticated calendar. Use a separate stream ID for the new source.')
  }
  const { state } = context
  for await (const page of client.events(calendarId, { syncToken: state?.syncToken, pageToken: state?.pageToken, recoveryCount: state?.recoveryCount })) {
    // Retain the input token on every continuation; only the terminal
    // checkpoint promotes nextSyncToken and clears recovery debt.
    const checkpoint: CalendarState = page.metadata?.nextSyncToken
      ? { scope, calendarId, syncToken: page.metadata.nextSyncToken }
      : { scope, calendarId, ...page.next }
    yield { rows: rawRows(page.items, (event) => JSON.stringify([client.settings.sourceId, calendarId, event.id])),
      state: checkpoint, id: page.metadata?.reset ? 'calendar-reset' : page.items.length === 0 ? 'calendar-empty-page' : undefined }
  }
}

export function parseCalendarState(raw: unknown, config: GoogleCalendarReaderConfig): CalendarState {
  if (checkpointScope.safeParse(raw).data?.scope !== calendarScope(config)) throw new Error('Calendar checkpoint scope changed. Migrate the state explicitly or use a new stream ID.')
  return checkpointSchema.parse(raw)
}

function calendarScope(config: Pick<GoogleCalendarReaderConfig, 'sourceId' | 'calendarId'>): string {
  return JSON.stringify([config.sourceId, config.calendarId, { singleEvents: false, showDeleted: true, maxResults: 250 }])
}
