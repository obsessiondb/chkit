import { definePipeline, defineStream, fullSync } from '@chkit/plugin-ingest'

import { lemlistConfig, type LemlistReaderConfig } from './config.js'
import { createActivityWindow, lemlist_activitiesRaw, readActivities } from './sources/activities.js'
import { lemlist_campaignsRaw, readCampaigns } from './sources/campaigns.js'
import { lemlist_contactsRaw, readContacts } from './sources/contacts.js'
import { lemlist_companiesRaw, readCompanies } from './sources/companies.js'
import { lemlist_campaignLeadsRaw, readCampaignLeads } from './sources/campaign-leads.js'
import { lemlist_inboxConversationsRaw, readInboxConversations } from './sources/inbox-conversations.js'
import { lemlist_inboxMessagesRaw, readInboxMessages } from './sources/inbox-messages.js'

/** One account pipeline; every resource owns its discovery and checkpoint. */
export function createLemlistPipeline(config: LemlistReaderConfig = lemlistConfig) {
  const boundConfig = { ...config, start: new Date(config.start), inboxUserIds: config.inboxUserIds ? [...config.inboxUserIds] : undefined }
  return definePipeline({
    id: boundConfig.sourceId, tags: ['provider:lemlist'], maxStreams: 1, maxFetches: 1,
    streams: [
      defineStream({
        id: `${boundConfig.sourceId}.activities`, tags: ['resource:activities'], destination: lemlist_activitiesRaw,
        incremental: createActivityWindow(boundConfig), batchSize: 500,
        read: (context) => readActivities(context, boundConfig),
      }),
      defineStream({
        id: `${boundConfig.sourceId}.campaigns`, tags: ['resource:campaigns'], destination: lemlist_campaignsRaw,
        incremental: fullSync(),
        read: (context) => readCampaigns(context, boundConfig),
      }),
      defineStream({ id: `${boundConfig.sourceId}.contacts`, tags: ['resource:contacts'], destination: lemlist_contactsRaw,
        incremental: fullSync(), read: (context) => readContacts(context, boundConfig) }),
      defineStream({ id: `${boundConfig.sourceId}.companies`, tags: ['resource:companies'], destination: lemlist_companiesRaw,
        incremental: fullSync(), read: (context) => readCompanies(context, boundConfig) }),
      defineStream({ id: `${boundConfig.sourceId}.campaign_leads`, tags: ['resource:campaign_leads'], destination: lemlist_campaignLeadsRaw,
        incremental: fullSync(), read: (context) => readCampaignLeads(context, boundConfig) }),
      defineStream({ id: `${boundConfig.sourceId}.inbox_conversations`, tags: ['resource:inbox_conversations'], destination: lemlist_inboxConversationsRaw,
        incremental: fullSync(), read: (context) => readInboxConversations(context, boundConfig) }),
      defineStream({ id: `${boundConfig.sourceId}.inbox_messages`, tags: ['resource:inbox_messages'], destination: lemlist_inboxMessagesRaw,
        incremental: fullSync(), read: (context) => readInboxMessages(context, boundConfig) }),
    ],
  })
}

export const lemlistPipeline = createLemlistPipeline()
