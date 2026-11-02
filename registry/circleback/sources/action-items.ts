import { rawTable, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { circlebackId, circlebackTags, createCirclebackClient, nonBlankString, toCirclebackRows } from '../client.js'
import { circlebackConfig, type CirclebackReaderConfig } from '../config.js'

// The official OpenAPI and Circleback CLI enumerate exactly these native completion statuses.
const statuses = ['PENDING', 'DONE']
const actionItem = z.looseObject({ id: circlebackId, meetingIds: z.array(nonBlankString), tags: circlebackTags })

export const circleback_actionItemsRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_action_items_raw' })

export async function* readActionItems(context: SourceContext, config: CirclebackReaderConfig) {
  const client = createCirclebackClient(context, config)
  for (const status of statuses) {
    for await (const page of client.pages('/action-items', actionItem, { assigneeType: 'Anyone', status })) {
      if (page.items.some((item) => item.status !== status)) throw new Error(`Circleback returned an action item outside the ${status} status partition.`)
      yield { rows: toCirclebackRows(page.items, (item) => item.id, client.settings.sourceId) }
    }
  }
}
