import { rawRows, rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createLemlistClient } from '../client.js'
import { lemlistConfig, type LemlistReaderConfig } from '../config.js'

export const lemlist_campaignLeadsRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_campaign_leads_raw' })

export async function* readCampaignLeads(context: SourceContext, config: LemlistReaderConfig) {
  const client = createLemlistClient(context, config)
  const { sourceId, pageSize } = client.settings
  // Own complete campaign discovery: old campaigns can gain leads without changing their creation date.
  for await (const campaigns of client.list('campaigns')) {
    for (const campaign of campaigns.items) {
      const leads = await client.campaignLeads(campaign._id)
      for (let offset = 0; offset < leads.length; offset += pageSize) {
        const rows = leads.slice(offset, offset + pageSize).map((data) => ({ source_id: sourceId, campaign_id: campaign._id, data }))
        yield { rows: rawRows(rows, ({ data }) => JSON.stringify([sourceId, campaign._id, data._id])) }
      }
    }
  }
}
