import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readPages, requestLemlist, requireItems, toLemlistRows, type LemlistClientDeps } from '../client.js'
import { lemlistConfig } from '../config.js'

export const lemlist_campaignLeadsRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_campaign_leads_raw' })

export async function* readCampaignLeads(context: FetchContext, deps: LemlistClientDeps) {
  // Own complete campaign discovery: old campaigns can gain leads without changing their creation date.
  for await (const campaigns of readPages(context, 'campaigns', undefined, deps)) {
    for (const campaign of campaigns) {
      // The normal lead list has a 500-row cap and no continuation. This endpoint explicitly exports all states.
      const leads = await context.attempt(async (signal) => requireItems(
        await requestLemlist(`/v2/campaigns/${encodeURIComponent(campaign._id)}/export/leads`, { state: 'all', format: 'json' }, signal, deps),
        'complete campaign lead export',
      ), { label: 'GET campaign lead export' })
      for (let offset = 0; offset < leads.length; offset += deps.config.pageSize) {
        yield { rows: toLemlistRows(leads.slice(offset, offset + deps.config.pageSize), deps, { campaign_id: campaign._id }) }
      }
    }
  }
}
