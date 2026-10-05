import { definePipeline, defineStream, IngestConfigError } from '@chkit/plugin-ingest'

import { classifyGoogleMeetError, defaultGoogleMeetClientDeps, type GoogleMeetClientDeps } from './client.js'
import { googleMeetConfig, type GoogleMeetReaderConfig } from './config.js'
import { google_meet_conferencesRaw, google_meet_transcriptsRaw, google_meet_transcriptEntriesRaw, parseMeetState, readResource, type Resource } from './sources/resources.js'

export function createGoogleMeetPipeline(config: GoogleMeetReaderConfig = googleMeetConfig, deps: GoogleMeetClientDeps = defaultGoogleMeetClientDeps) {
  const boundConfig = { ...config }
  if (!boundConfig.sourceId.trim() || !boundConfig.streamPrefix.trim()) throw new IngestConfigError('Meet sourceId and streamPrefix must be non-empty strings.')
  if (![boundConfig.lookbackDays, boundConfig.windowDays].every((days) => Number.isFinite(days) && days > 0) || !Number.isFinite(boundConfig.overlapDays) || boundConfig.overlapDays < 0) {
    throw new IngestConfigError('Meet lookbackDays and windowDays must be positive; overlapDays must be non-negative.')
  }
  if (!Number.isSafeInteger(boundConfig.maxPendingConferences) || boundConfig.maxPendingConferences <= 0) throw new IngestConfigError('Meet maxPendingConferences must be a positive safe integer.')
  const client = { ...deps, config: boundConfig }
  return definePipeline({
    id: boundConfig.streamPrefix, tags: ['provider:google-meet'], maxStreams: 1, maxFetches: 1,
    streams: [
      resourceStream('conferences', google_meet_conferencesRaw, client),
      resourceStream('transcripts', google_meet_transcriptsRaw, client),
      resourceStream('transcript-entries', google_meet_transcriptEntriesRaw, client),
    ],
  })
}

export const google_meetPipeline = createGoogleMeetPipeline()

function resourceStream(resource: Resource, destination: typeof google_meet_conferencesRaw, deps: GoogleMeetClientDeps) {
  const config = deps.config
  return defineStream({
    id: `${config.streamPrefix}.${resource}`, tags: [`resource:${resource}`], destination,
    incremental: {
      id: `${config.streamPrefix}.${resource}.pending`, version: 1,
      parseState: (raw) => parseMeetState(raw, config),
      plan: ({ range }) => range,
    },
    batchSize: 1,
    budget: { maxChunks: config.maxChunks, maxChunkRows: 100 },
    classifyError: classifyGoogleMeetError,
    read: (context) => readResource(context, resource, deps),
  })
}
