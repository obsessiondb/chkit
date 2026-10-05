import { IngestConfigError, rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { numericId, readCirclebackPages, tagNames, toCirclebackRows, type CirclebackClientDeps } from '../client.js'
import { circlebackConfig } from '../config.js'

// The official OpenAPI and Circleback CLI enumerate exactly these native completion statuses.
const statuses = ['PENDING', 'DONE']

export const circleback_actionItemsRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_action_items_raw' })

export async function* readActionItems(context: FetchContext, deps: CirclebackClientDeps) {
  for (const status of statuses) {
    for await (const page of readCirclebackPages(context, { path: '/action-items', query: { assigneeType: 'Anyone', status } }, deps)) {
      for (const item of page) {
        if (item.status !== status || !Array.isArray(item.meetingIds) ||
          !item.meetingIds.every((id: unknown) => typeof id === 'string' && id.trim())) {
          throw new IngestConfigError('Circleback action item has an unexpected status or invalid meeting IDs.')
        }
      }
      yield { rows: toCirclebackRows(page.map(tagNames), (item) => numericId(item.id, 'action item'), deps.config.sourceId) }
    }
  }
}
