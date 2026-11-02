import { definePipeline, defineStream } from '@chkit/plugin-ingest'

import { slackConfig, type SlackReaderConfig } from './config.js'
import { readChannels, slackChannelsRaw } from './sources/channels.js'
import { readUsers, slackUsersRaw } from './sources/users.js'
import { readMessages, slackMessagesRaw } from './sources/messages.js'
import { slackMessageStrategy } from './state.js'

// One installation pipeline, with independent streams for the three resource types.
// Destination names come from config.ts when the raw schemas load.
export function createSlackPipeline(config: SlackReaderConfig = slackConfig) {
  const boundConfig = { ...config, channels: config.channels ? [...config.channels] : undefined, conversationTypes: [...config.conversationTypes] }
  return definePipeline({
    id: boundConfig.sourceId,
    tags: ['provider:slack'],
    maxStreams: 1,
    maxFetches: 1,
    maxLoads: 1,
    retry: { retries: 5, minTimeout: 1_000, maxTimeout: 60_000, randomize: true },
    streams: [
      defineStream({ batchSize: 500, id: `${boundConfig.sourceId}.channels`, tags: ['resource:channels'], destination: slackChannelsRaw, read: (context) => readChannels(context, boundConfig) }),
      defineStream({ batchSize: 500, id: `${boundConfig.sourceId}.users`, tags: ['resource:users'], destination: slackUsersRaw, read: (context) => readUsers(context, boundConfig) }),
      defineStream({ batchSize: 1, id: `${boundConfig.sourceId}.messages`, tags: ['resource:messages'], destination: slackMessagesRaw, incremental: slackMessageStrategy, read: (context) => readMessages(context, boundConfig) }),
    ],
  })
}

export const slack = createSlackPipeline()
