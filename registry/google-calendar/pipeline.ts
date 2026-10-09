import { cursorState, definePipeline, defineStream, IngestConfigError } from '@chkit/plugin-ingest'

import { classifyGoogleCalendarError, defaultGoogleCalendarClientDeps, type GoogleCalendarClientDeps } from './client.js'
import { googleCalendarConfig, type GoogleCalendarReaderConfig } from './config.js'
import { google_calendar_eventsRaw, parseCalendarState, readEvents, type CalendarState } from './sources/events.js'

export function createGoogleCalendarPipeline(config: GoogleCalendarReaderConfig = googleCalendarConfig, deps: GoogleCalendarClientDeps = defaultGoogleCalendarClientDeps) {
  const boundConfig = { ...config }
  if (!boundConfig.sourceId.trim() || !boundConfig.streamPrefix.trim() || !boundConfig.calendarId.trim()) throw new IngestConfigError('Calendar sourceId, streamPrefix and calendarId must be non-empty strings.')
  const client = { ...deps, config: boundConfig }
  return definePipeline({
    id: boundConfig.streamPrefix, tags: ['provider:google-calendar'], maxStreams: 1, maxFetches: 1,
    streams: [defineStream({
      id: `${boundConfig.streamPrefix}.events`, tags: ['resource:events'], destination: google_calendar_eventsRaw,
      incremental: {
        ...cursorState<CalendarState>({ id: `${boundConfig.streamPrefix}.sync-token`, version: 1, parse: (raw) => parseCalendarState(raw, boundConfig) }),
        plan({ state, range }) {
          if (range?.from || range?.to) throw new IngestConfigError('Calendar canonical sync does not accept date bounds. Use a separate bounded instances reader for an occurrence backfill.')
          return state
        },
      },
      batchSize: 1,
      budget: { maxChunks: boundConfig.maxChunks, maxChunkRows: 250 },
      classifyError: classifyGoogleCalendarError,
      read: (context) => readEvents(context, client),
    })],
  })
}

export const google_calendarPipeline = createGoogleCalendarPipeline()
