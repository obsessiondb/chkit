import { definePipeline, defineStream, timestampWindow } from '@chkit/plugin-ingest'

import { classifyLinearError, defaultLinearClientDeps, type LinearClientDeps } from './client.js'
import { linearConfig, type LinearConfig } from './config.js'
import { linear_issuesRaw, readIssues } from './sources/issues.js'

export function createLinearPipeline(config: LinearConfig = linearConfig, deps: LinearClientDeps = defaultLinearClientDeps) {
  const source = { ...config, start: new Date(config.start) }
  return definePipeline({
    id: source.sourceId, tags: ['provider:linear'], maxStreams: 1, maxFetches: 1,
    streams: [defineStream({
      id: `${source.sourceId}.issues`, tags: ['resource:issues'], destination: linear_issuesRaw,
      // Newest-first pages cannot advance a safe watermark until the whole window loads.
      incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
      classifyError: classifyLinearError,
      read: (context) => readIssues(context, deps),
    })],
  })
}

export const linearPipeline = createLinearPipeline()
