import { cursorState, definePipeline, defineStream } from '@chkit/plugin-ingest'

import { googleMeetConfig, type GoogleMeetReaderConfig } from './config.js'
import { google_meet_conferencesRaw, google_meet_transcriptsRaw, google_meet_transcriptEntriesRaw, google_meet_participantsRaw, google_meet_participantSessionsRaw, google_meet_recordingsRaw, parseMeetState, readResource, type MeetSelection, type MeetState, type Resource } from './sources/resources.js'

export function createGoogleMeetPipeline(config: GoogleMeetReaderConfig = googleMeetConfig) {
  const boundConfig = { ...config }
  return definePipeline({
    id: boundConfig.streamPrefix, tags: ['provider:google-meet'], maxStreams: 1, maxFetches: 1,
    streams: [
      resourceStream('conferences', google_meet_conferencesRaw, boundConfig),
      resourceStream('transcripts', google_meet_transcriptsRaw, boundConfig),
      resourceStream('transcript-entries', google_meet_transcriptEntriesRaw, boundConfig),
      resourceStream('participants', google_meet_participantsRaw, boundConfig),
      resourceStream('participant-sessions', google_meet_participantSessionsRaw, boundConfig),
      resourceStream('recordings', google_meet_recordingsRaw, boundConfig),
    ],
  })
}

export const google_meetPipeline = createGoogleMeetPipeline()

function resourceStream(resource: Resource, destination: typeof google_meet_conferencesRaw, config: GoogleMeetReaderConfig) {
  const checkpoint = cursorState({ id: `${config.streamPrefix}.${resource}.pages`, version: 2, parse: (raw) => parseMeetState(raw, config) })
  return defineStream<Record<string, unknown>, MeetState, MeetSelection>({
    id: `${config.streamPrefix}.${resource}`, tags: [`resource:${resource}`], destination,
    incremental: {
      id: checkpoint.id, version: checkpoint.version, parseState: checkpoint.parseState,
      plan: ({ range }) => {
        for (const bound of [range?.from, range?.to]) {
          if (bound !== undefined && (!(bound instanceof Date) || !Number.isFinite(bound.getTime()))) throw new Error('Meet backfill bounds must be valid dates.')
        }
        return range
      },
    },
    batchSize: 1,
    budget: { maxChunks: config.maxChunks, maxChunkRows: 100 },
    read: (context) => readResource(context, resource, config),
  })
}
