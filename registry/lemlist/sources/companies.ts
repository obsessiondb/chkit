import { rawRows, rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createLemlistClient } from '../client.js'
import { lemlistConfig, type LemlistReaderConfig } from '../config.js'

export const lemlist_companiesRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_companies_raw' })

export async function* readCompanies(context: SourceContext, config: LemlistReaderConfig) {
  const client = createLemlistClient(context, config)
  const { sourceId } = client.settings
  for await (const page of client.list('companies')) {
    yield { rows: rawRows(page.items.map((data) => ({ source_id: sourceId, data })), ({ data }) => JSON.stringify([sourceId, data._id])) }
  }
}
