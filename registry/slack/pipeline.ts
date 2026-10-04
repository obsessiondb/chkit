import { definePipeline, defineStream } from '@chkit/plugin-ingest'

import { classifySlackError } from './client.js'
import { slackConfig } from './config.js'
import { readChannels, slackChannelsRaw } from './sources/channels.js'
import { readUsers, slackUsersRaw } from './sources/users.js'
import { readMessages, slackMessagesRaw } from './sources/messages.js'
import { slackMessageStrategy } from './state.js'

const streamOptions = { classifyError: classifySlackError, batchSize: 500 }

// Delete a stream entry to stop collecting it; keep its schema export to retain existing data.
export const slack = definePipeline({
  id: slackConfig.sourceId,
  tags: ['provider:slack'],
  maxStreams: 1,
  maxFetches: 1,
  maxLoads: 1,
  retry: { retries: 5, minTimeout: 1_000, maxTimeout: 60_000, randomize: true },
  streams: [
    defineStream({ ...streamOptions, id: `${slackConfig.sourceId}.channels`, tags: ['resource:channels'], destination: slackChannelsRaw, read: readChannels }),
    defineStream({ ...streamOptions, id: `${slackConfig.sourceId}.users`, tags: ['resource:users'], destination: slackUsersRaw, read: readUsers }),
    defineStream({ ...streamOptions, batchSize: 1, id: `${slackConfig.sourceId}.messages`, tags: ['resource:messages'], destination: slackMessagesRaw, incremental: slackMessageStrategy, read: readMessages }),
  ],
})
