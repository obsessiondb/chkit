import { definePipeline, defineStream, fullSync, IngestConfigError } from '@chkit/plugin-ingest'

import { classifyCirclebackError, defaultCirclebackClientDeps, type CirclebackClientDeps } from './client.js'
import { circlebackConfig, type CirclebackReaderConfig } from './config.js'
import { circleback_meetingsRaw, readMeetings } from './sources/meetings.js'
import { circleback_meetingTranscriptsRaw, readMeetingTranscripts } from './sources/meeting-transcripts.js'
import { circleback_actionItemsRaw, readActionItems } from './sources/action-items.js'
import { circleback_peopleRaw, readPeople } from './sources/people.js'
import { circleback_companiesRaw, readCompanies } from './sources/companies.js'

export function createCirclebackPipeline(config: CirclebackReaderConfig = circlebackConfig, deps: CirclebackClientDeps = defaultCirclebackClientDeps) {
  if (!config.sourceId.trim() || !['All', 'Mine', 'Shared'].includes(config.ownership)) {
    throw new IngestConfigError('Circleback needs a sourceId and valid meeting ownership.')
  }
  const source = { ...config }, client = { ...deps, config: source }
  const options = { incremental: fullSync(), classifyError: classifyCirclebackError }
  return definePipeline({
    id: source.sourceId, tags: ['provider:circleback'], maxStreams: 1, maxFetches: 1,
    streams: [
      defineStream({ ...options, id: `${source.sourceId}.meetings`, tags: ['resource:meetings'], destination: circleback_meetingsRaw,
        read: (context) => readMeetings(context, client) }),
      defineStream({ ...options, id: `${source.sourceId}.meeting_transcripts`, tags: ['resource:meeting_transcripts'], destination: circleback_meetingTranscriptsRaw,
        read: (context) => readMeetingTranscripts(context, client) }),
      defineStream({ ...options, id: `${source.sourceId}.action_items`, tags: ['resource:action_items'], destination: circleback_actionItemsRaw,
        read: (context) => readActionItems(context, client) }),
      defineStream({ ...options, id: `${source.sourceId}.people`, tags: ['resource:people'], destination: circleback_peopleRaw,
        read: (context) => readPeople(context, client) }),
      defineStream({ ...options, id: `${source.sourceId}.companies`, tags: ['resource:companies'], destination: circleback_companiesRaw,
        read: (context) => readCompanies(context, client) }),
    ],
  })
}

export const circlebackPipeline = createCirclebackPipeline()
