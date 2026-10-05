import { IngestConfigError, rawRows, rawTable, timestampWindow, type IncrementalStrategy, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { readPages, type LemlistClientDeps } from '../client.js'
import { lemlistConfig, type LemlistReaderConfig } from '../config.js'

export const lemlist_activitiesRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_activities_raw' })

export async function* readActivities(context: ReadContext<TimestampRange, TimestampWindowState>, deps: LemlistClientDeps) {
  for (let from = context.selection.from; from < context.selection.to;) {
    const to = new Date(Math.min(from.getTime() + deps.config.intervalMs, context.selection.to.getTime()))
    for await (const page of readPages(context, 'activities', { from, to }, deps)) {
      yield { rows: rawRows(page.items, (item) => item._id) }
    }
    // Only an exhausted interval is a safe frontier. Its mutable offsets restart at zero.
    const watermark = new Date(Math.max(to.getTime(), Date.parse(context.state?.watermark ?? to.toISOString()))).toISOString()
    yield { rows: [], state: { watermark }, id: `completed-interval:${from.toISOString()}/${to.toISOString()}` }
    from = to
  }
}

export function createActivityWindow(config: LemlistReaderConfig): IncrementalStrategy<TimestampWindowState, TimestampRange> {
  const window = timestampWindow({ start: config.start, overlapMs: config.overlapMs })
  return {
    ...window,
    plan(input: Parameters<typeof window.plan>[0]) {
      const selection = window.plan(input)
      if (input.range && input.state) {
        const frontier = Date.parse(input.state.watermark)
        if (selection.to.getTime() < frontier) {
          throw new IngestConfigError('Lemlist backfill upper bound precedes its committed interval frontier; use a new backfill ID for a narrower historical range.')
        }
        return { ...selection, from: new Date(Math.max(selection.from.getTime(), frontier - config.overlapMs)) }
      }
      return selection
    },
  }
}
