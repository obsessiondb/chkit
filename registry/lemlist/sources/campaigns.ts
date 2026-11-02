import { rawRows, rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createLemlistClient } from '../client.js'
import { lemlistConfig, type LemlistReaderConfig } from '../config.js'

export const lemlist_campaignsRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_campaigns_raw' })

// No reliable modification filter: default fullSync records completion and safely replays failures.
export async function* readCampaigns(context: SourceContext, config: LemlistReaderConfig) {
  const client = createLemlistClient(context, config)
  for await (const page of client.list('campaigns')) {
    yield { rows: rawRows(page.items, (item) => item._id) }
  }
}
