import { definePipeline, defineStream, fullSync, IngestConfigError } from '@chkit/plugin-ingest'

import { defaultLemlistClientDeps, type LemlistClientDeps } from './client.js'
import { lemlistConfig, type LemlistReaderConfig } from './config.js'
import { createActivityWindow, lemlist_activitiesRaw, readActivities } from './sources/activities.js'
import { lemlist_campaignsRaw, readCampaigns } from './sources/campaigns.js'
import { lemlist_contactsRaw, readContacts } from './sources/contacts.js'
import { lemlist_companiesRaw, readCompanies } from './sources/companies.js'
import { lemlist_campaignLeadsRaw, readCampaignLeads } from './sources/campaign-leads.js'
import { lemlist_inboxConversationsRaw, readInboxConversations } from './sources/inbox-conversations.js'
import { lemlist_inboxMessagesRaw, readInboxMessages } from './sources/inbox-messages.js'

/** One account pipeline; every resource owns its discovery and checkpoint. */
export function createLemlistPipeline(config: LemlistReaderConfig = lemlistConfig, deps: LemlistClientDeps = defaultLemlistClientDeps) {
  if (!config.sourceId.trim() || !Number.isSafeInteger(config.pageSize) || config.pageSize <= 0 || config.pageSize > 100 ||
    !Number.isSafeInteger(config.intervalMs) || config.intervalMs <= 0 ||
    (config.inboxUserIds !== undefined && (!Array.isArray(config.inboxUserIds) ||
      config.inboxUserIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(config.inboxUserIds).size !== config.inboxUserIds.length))) {
    throw new IngestConfigError('Lemlist needs a sourceId, pageSize from 1 to 100, positive intervalMs, and distinct nonempty inboxUserIds.')
  }
  const client = { ...deps, config: { ...config, start: new Date(config.start), inboxUserIds: config.inboxUserIds ? [...config.inboxUserIds] : undefined } }
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
        incremental: fullSync(),
        read: (context) => readCampaigns(context, client),
      }),
      defineStream({ id: `${config.sourceId}.contacts`, tags: ['resource:contacts'], destination: lemlist_contactsRaw,
        incremental: fullSync(), read: (context) => readContacts(context, client) }),
      defineStream({ id: `${config.sourceId}.companies`, tags: ['resource:companies'], destination: lemlist_companiesRaw,
        incremental: fullSync(), read: (context) => readCompanies(context, client) }),
      defineStream({ id: `${config.sourceId}.campaign_leads`, tags: ['resource:campaign_leads'], destination: lemlist_campaignLeadsRaw,
        incremental: fullSync(), read: (context) => readCampaignLeads(context, client) }),
      defineStream({ id: `${config.sourceId}.inbox_conversations`, tags: ['resource:inbox_conversations'], destination: lemlist_inboxConversationsRaw,
        incremental: fullSync(), read: (context) => readInboxConversations(context, client) }),
      defineStream({ id: `${config.sourceId}.inbox_messages`, tags: ['resource:inbox_messages'], destination: lemlist_inboxMessagesRaw,
        incremental: fullSync(), read: (context) => readInboxMessages(context, client) }),
    ],
  })
}

export const lemlistPipeline = createLemlistPipeline()
