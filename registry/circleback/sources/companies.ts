import { IngestConfigError, rawRows, rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { numericId, readCirclebackPages, requestCircleback, requireCirclebackObject, tagNames, type CirclebackClientDeps, type CirclebackObject } from '../client.js'
import { circlebackConfig } from '../config.js'

export const circleback_companiesRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_companies_raw' })

export async function* readCompanies(context: FetchContext, deps: CirclebackClientDeps) {
  for await (const page of readCirclebackPages(context, { path: '/companies' }, deps)) {
    for (const listed of page.items) {
      const domain = companyDomain(listed)
      const detail = await context.attempt(async (signal) => {
        const response = await requestCircleback(`/company/${encodeURIComponent(domain)}`, signal, deps)
        return requireCirclebackObject(await response.json(), 'company detail')
      }, { label: 'GET /company/{domain}' })
      if (companyDomain(detail) !== domain || !Array.isArray(detail.people) || !Array.isArray(detail.externalLinks)) {
        throw new IngestConfigError('Circleback company detail changed its domain or omitted people/external links.')
      }
      const companyIds = new Set<number>()
      for (const item of [listed, detail]) {
        if (item.id !== undefined) companyIds.add(numericId(item.id, 'company'))
      }
      for (const value of detail.people) {
        const person = requireCirclebackObject(value, 'company person')
        numericId(person.id, 'company person')
        if (person.companyId !== null) companyIds.add(numericId(person.companyId, 'person company'))
      }
      if (companyIds.size > 1) throw new IngestConfigError('Circleback company returned conflicting numeric company IDs.')
      const snapshot = { source_id: deps.config.sourceId, company_id: [...companyIds][0] ?? null, data: tagNames({ ...listed, ...detail }) }
      // The provider domain is always the identity, even when an optional numeric ID appears later.
      yield { rows: rawRows([snapshot], () => JSON.stringify([deps.config.sourceId, domain])) }
    }
  }
}

function companyDomain(item: CirclebackObject): string {
  if (typeof item.domain !== 'string' || !item.domain.trim()) throw new IngestConfigError('Circleback company has no domain.')
  return item.domain
}
