import { cursorState, definePipeline, defineStream, IngestConfigError } from '@chkit/plugin-ingest'

import { classifyGoogleMeetError, defaultGoogleMeetClientDeps, type GoogleMeetClientDeps } from './client.js'
import { googleMeetConfig, type GoogleMeetReaderConfig } from './config.js'
import { google_meet_conferencesRaw, google_meet_transcriptsRaw, google_meet_transcriptEntriesRaw, google_meet_participantsRaw, google_meet_participantSessionsRaw, google_meet_recordingsRaw, parseMeetState, readResource, type MeetSelection, type MeetState, type Resource } from './sources/resources.js'

export function createGoogleMeetPipeline(config: GoogleMeetReaderConfig = googleMeetConfig, deps: GoogleMeetClientDeps = defaultGoogleMeetClientDeps) {
  const boundConfig = { ...config }
  if (!boundConfig.sourceId.trim() || !boundConfig.streamPrefix.trim()) throw new IngestConfigError('Meet sourceId and streamPrefix must be non-empty strings.')
  if (!Number.isFinite(boundConfig.lookbackHours) || boundConfig.lookbackHours <= 0) throw new IngestConfigError('Meet lookbackHours must be positive.')
  if (!Number.isSafeInteger(boundConfig.pageSize) || boundConfig.pageSize <= 0 || boundConfig.pageSize > 100) throw new IngestConfigError('Meet pageSize must be an integer between one and 100.')
  if (!Number.isSafeInteger(boundConfig.maxChunks) || boundConfig.maxChunks <= 0) throw new IngestConfigError('Meet maxChunks must be a positive safe integer.')
  const client = { ...deps, config: boundConfig }
  return definePipeline({
    id: boundConfig.streamPrefix, tags: ['provider:google-meet'], maxStreams: 1, maxFetches: 1,
    streams: [
      resourceStream('conferences', google_meet_conferencesRaw, client),
      resourceStream('transcripts', google_meet_transcriptsRaw, client),
      resourceStream('transcript-entries', google_meet_transcriptEntriesRaw, client),
      resourceStream('participants', google_meet_participantsRaw, client),
      resourceStream('participant-sessions', google_meet_participantSessionsRaw, client),
      resourceStream('recordings', google_meet_recordingsRaw, client),
    ],
  })
}

export const google_meetPipeline = createGoogleMeetPipeline()

function resourceStream(resource: Resource, destination: typeof google_meet_conferencesRaw, deps: GoogleMeetClientDeps) {
  const config = deps.config
  const checkpoint = cursorState({ id: `${config.streamPrefix}.${resource}.pages`, version: 2, parse: (raw) => parseMeetState(raw, config) })
  return defineStream<Record<string, unknown>, MeetState, MeetSelection>({
    id: `${config.streamPrefix}.${resource}`, tags: [`resource:${resource}`], destination,
    incremental: {
      id: checkpoint.id, version: checkpoint.version, parseState: checkpoint.parseState,
      plan: ({ range }) => range,
    },
    batchSize: 1,
    budget: { maxChunks: config.maxChunks, maxChunkRows: 100 },
    classifyError: classifyGoogleMeetError,
    read: (context) => readResource(context, resource, deps),
  })
}
