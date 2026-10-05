import { IngestConfigError, rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { numericId, readCirclebackPages, requestCircleback, requireCirclebackObject, tagNames, toCirclebackRows, type CirclebackClientDeps } from '../client.js'
import { circlebackConfig } from '../config.js'

export const circleback_peopleRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_people_raw' })

export async function* readPeople(context: FetchContext, deps: CirclebackClientDeps) {
  for await (const page of readCirclebackPages(context, { path: '/people' }, deps)) {
    for (const listed of page) {
      const id = numericId(listed.id, 'person')
      const detail = await context.attempt(async (signal) => {
        const response = await requestCircleback(`/person/${id}`, signal, deps)
        const person = requireCirclebackObject(await response.json(), 'person detail')
        if (numericId(person.id, 'person detail') !== id || !Array.isArray(person.externalLinks)) {
          throw new IngestConfigError('Circleback person detail changed its ID or omitted external links.')
        }
        return person
      }, { label: 'GET /person/{profileId}' })
      yield { rows: toCirclebackRows([tagNames({ ...listed, ...detail })], (item) => numericId(item.id, 'person'), deps.config.sourceId) }
    }
  }
}
