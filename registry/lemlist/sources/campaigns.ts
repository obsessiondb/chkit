import { rawRows, rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readPages, type LemlistClientDeps } from '../client.js'
import { lemlistConfig } from '../config.js'

export const lemlist_campaignsRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_campaigns_raw' })

// No reliable modification filter: default fullSync records completion and safely replays failures.
export async function* readCampaigns(context: FetchContext, deps: LemlistClientDeps) {
  for await (const page of readPages(context, 'campaigns', undefined, deps)) {
    yield { rows: rawRows(page, (item) => item._id) }
  }
}
