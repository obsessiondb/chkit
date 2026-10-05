import { definePipeline, defineStream, IngestConfigError } from '@chkit/plugin-ingest'

import { defaultCirclebackClientDeps, type CirclebackClientDeps } from './client.js'
import { circlebackConfig, type CirclebackReaderConfig } from './config.js'
import { circleback_meetingsRaw, createMeetingStrategy, readMeetings } from './sources/meetings.js'

export function createCirclebackPipeline(config: CirclebackReaderConfig = circlebackConfig, deps: CirclebackClientDeps = defaultCirclebackClientDeps) {
  if (!config.sourceId.trim() || !config.sourceIdentity.trim() || !config.ownership.trim() ||
    !Number.isSafeInteger(config.maxRetainedMeetings) || config.maxRetainedMeetings <= 0) {
    throw new IngestConfigError('Circleback needs source identities, ownership, and a positive maxRetainedMeetings.')
  }
  const client = { ...deps, config: { ...config } }
  return definePipeline({
    id: config.sourceId, tags: ['provider:circleback'], maxStreams: 1, maxFetches: 1,
    streams: [defineStream({
      id: `${config.sourceId}.meetings`, tags: ['resource:meetings'], destination: circleback_meetingsRaw,
      incremental: createMeetingStrategy(client.config),
      // Each meeting's enrichment and recovery state must be acknowledged together.
      batchSize: 1,
      read: (context) => readMeetings(context, client),
    })],
  })
}

export const circlebackPipeline = createCirclebackPipeline()
