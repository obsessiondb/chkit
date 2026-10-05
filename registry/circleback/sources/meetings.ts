import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { meetingId, readCirclebackPages, tagNames, toCirclebackRows, type CirclebackClientDeps } from '../client.js'
import { circlebackConfig } from '../config.js'

export const circleback_meetingsRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_meetings_raw' })

export async function* readMeetings(context: FetchContext, deps: CirclebackClientDeps) {
  for await (const page of readCirclebackPages(context, { path: '/meetings', query: { ownership: deps.config.ownership } }, deps)) {
    yield { rows: toCirclebackRows(page.items.map(tagNames), meetingId, deps.config.sourceId) }
  }
}
