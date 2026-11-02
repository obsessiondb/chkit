import { rawRows, rawTable, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { circlebackId, circlebackTags, createCirclebackClient, nonBlankString } from '../client.js'
import { circlebackConfig, type CirclebackReaderConfig } from '../config.js'

const company = z.looseObject({ domain: nonBlankString, id: circlebackId.optional(), tags: circlebackTags })
const companyDetail = company.extend({
  people: z.array(z.looseObject({ id: circlebackId, companyId: circlebackId.nullable() })),
  externalLinks: z.array(z.unknown()),
})

export const circleback_companiesRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_companies_raw' })

export async function* readCompanies(context: SourceContext, config: CirclebackReaderConfig) {
  const client = createCirclebackClient(context, config)
  const { sourceId } = client.settings
  for await (const page of client.pages('/companies', company)) {
    for (const listed of page.items) {
      const detail = await client.detail(`/company/${encodeURIComponent(listed.domain)}`, companyDetail)
      if (detail.domain !== listed.domain) throw new Error('Circleback company detail changed its domain.')
      const companyIds = new Set([listed.id, detail.id, ...detail.people.map((person) => person.companyId)].flatMap((id) => id ?? []))
      if (companyIds.size > 1) throw new Error('Circleback company returned conflicting numeric company IDs.')
      const snapshot = { source_id: sourceId, company_id: [...companyIds][0] ?? null, data: { ...listed, ...detail } }
      // The provider domain is always the identity, even when an optional numeric ID appears later.
      yield { rows: rawRows([snapshot], () => JSON.stringify([sourceId, listed.domain])) }
    }
  }
}
