import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readPages, toLemlistRows, type LemlistClientDeps } from '../client.js'
import { lemlistConfig } from '../config.js'

export const lemlist_companiesRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_companies_raw' })

export async function* readCompanies(context: FetchContext, deps: LemlistClientDeps) {
  for await (const page of readPages(context, 'companies', undefined, deps)) {
    yield { rows: toLemlistRows(page.items, deps) }
  }
}
