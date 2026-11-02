import { rawTable, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { circlebackId, circlebackTags, createCirclebackClient, toCirclebackRows } from '../client.js'
import { circlebackConfig, type CirclebackReaderConfig } from '../config.js'

const person = z.looseObject({ id: circlebackId, tags: circlebackTags })
const personDetail = person.extend({ externalLinks: z.array(z.unknown()) })

export const circleback_peopleRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_people_raw' })

export async function* readPeople(context: SourceContext, config: CirclebackReaderConfig) {
  const client = createCirclebackClient(context, config)
  for await (const page of client.pages('/people', person)) {
    for (const listed of page.items) {
      const detail = await client.detail(`/person/${listed.id}`, personDetail)
      if (detail.id !== listed.id) throw new Error('Circleback person detail changed its ID.')
      yield { rows: toCirclebackRows([{ ...listed, ...detail }], (item) => item.id, client.settings.sourceId) }
    }
  }
}
