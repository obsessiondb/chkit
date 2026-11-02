import { rawTable, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { circlebackTags, createCirclebackClient, nonBlankString, toCirclebackRows } from '../client.js'
import { circlebackConfig, type CirclebackReaderConfig } from '../config.js'

const meeting = z.looseObject({ id: nonBlankString, tags: circlebackTags })

export const circleback_meetingsRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_meetings_raw' })

export async function* readMeetings(context: SourceContext, config: CirclebackReaderConfig) {
  const client = createCirclebackClient(context, config)
  for await (const page of client.pages('/meetings', meeting, { ownership: client.settings.ownership })) {
    yield { rows: toCirclebackRows(page.items, (item) => item.id, client.settings.sourceId) }
  }
}
