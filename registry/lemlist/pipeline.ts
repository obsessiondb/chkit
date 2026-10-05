import { definePipeline, defineStream, IngestConfigError } from '@chkit/plugin-ingest'

import { defaultLemlistClientDeps, type LemlistClientDeps } from './client.js'
import { lemlistConfig, type LemlistReaderConfig } from './config.js'
import { createActivityWindow, lemlist_activitiesRaw, readActivities } from './sources/activities.js'
import { lemlist_campaignsRaw, readCampaigns } from './sources/campaigns.js'

/** One account pipeline, with independent activities and campaigns checkpoints. */
export function createLemlistPipeline(config: LemlistReaderConfig = lemlistConfig, deps: LemlistClientDeps = defaultLemlistClientDeps) {
  if (!config.sourceId.trim() || !Number.isSafeInteger(config.pageSize) || config.pageSize <= 0 ||
    !Number.isSafeInteger(config.intervalMs) || config.intervalMs <= 0) {
    throw new IngestConfigError('Lemlist needs a sourceId, positive pageSize, and positive intervalMs.')
  }
  const client = { ...deps, config: { ...config, start: new Date(config.start) } }
  return definePipeline({
    id: config.sourceId, tags: ['provider:lemlist'], maxStreams: 1, maxFetches: 1,
    streams: [
      defineStream({
        id: `${config.sourceId}.activities`, tags: ['resource:activities'], destination: lemlist_activitiesRaw,
        incremental: createActivityWindow(client.config), batchSize: 500,
        read: (context) => readActivities(context, client),
      }),
      defineStream({
        id: `${config.sourceId}.campaigns`, tags: ['resource:campaigns'], destination: lemlist_campaignsRaw,
        read: (context) => readCampaigns(context, client),
      }),
    ],
  })
}

export const lemlistPipeline = createLemlistPipeline()
