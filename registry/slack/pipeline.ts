import { definePipeline, defineStream } from '@chkit/plugin-ingest'

import { classifySlackError, defaultSlackClientDeps, type SlackClientDeps } from './client.js'
import { slackConfig, type SlackReaderConfig } from './config.js'
import { readChannels, slackChannelsRaw } from './sources/channels.js'
import { readUsers, slackUsersRaw } from './sources/users.js'
import { readMessages, slackMessagesRaw } from './sources/messages.js'
import { createSlackMessageStrategy } from './state.js'

const streamOptions = { classifyError: classifySlackError, batchSize: 500 }

// One installation pipeline, with independent streams for the three resource types.
// Destination names come from config.ts when the raw schemas load.
export function createSlackPipeline(config: SlackReaderConfig = slackConfig, deps: SlackClientDeps = defaultSlackClientDeps) {
  const boundConfig = { ...config, channels: config.channels ? [...config.channels] : undefined, conversationTypes: [...config.conversationTypes] }
  const client = { ...deps, config: boundConfig }
  return definePipeline({
    id: boundConfig.sourceId,
    tags: ['provider:slack'],
    maxStreams: 1,
    maxFetches: 1,
    maxLoads: 1,
    retry: { retries: 5, minTimeout: 1_000, maxTimeout: 60_000, randomize: true },
    streams: [
      defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.channels`, tags: ['resource:channels'], destination: slackChannelsRaw, read: (context) => readChannels(context, client) }),
      defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.users`, tags: ['resource:users'], destination: slackUsersRaw, read: (context) => readUsers(context, client) }),
      defineStream({ ...streamOptions, batchSize: 1, id: `${boundConfig.sourceId}.messages`, tags: ['resource:messages'], destination: slackMessagesRaw, incremental: createSlackMessageStrategy(boundConfig), read: (context) => readMessages(context, client) }),
    ],
  })
}

export const slack = createSlackPipeline()
