import { definePipeline, defineStream, HttpError, IngestConfigError, rawRows, rawTable, timestampWindow, type FetchContext, type IncrementalStrategy, type TimestampRange } from '@chkit/plugin-ingest'

const database = 'default'
// Keep stream IDs and destinations tied to one Lemlist account; use new ones when switching accounts.
const pageSize = 100
const intervalMs = 30 * 24 * 60 * 60 * 1000
const activityWindow = timestampWindow({ start: new Date('2000-01-01T00:00:00Z'), overlapMs: 24 * 60 * 60 * 1000 })

interface Item { _id: string; [key: string]: unknown }
interface ScanState { completedAt: string }

export const lemlist_activitiesRaw = rawTable({ database, name: 'lemlist_activities_raw' })
export const lemlist_campaignsRaw = rawTable({ database, name: 'lemlist_campaigns_raw' })

const campaignScan: IncrementalStrategy<ScanState, string> = {
  id: 'lemlist.campaigns.full_scan', version: 1,
  parseState(raw) {
    if (!isObject(raw) || typeof raw.completedAt !== 'string' || !Number.isFinite(Date.parse(raw.completedAt))) {
      throw new IngestConfigError('Lemlist campaign checkpoint has no valid completedAt.')
    }
    return { completedAt: raw.completedAt }
  },
  plan: ({ cutoff }) => cutoff.toISOString(),
  complete: ({ selection }) => ({ completedAt: selection }),
}

export const lemlistPipeline = definePipeline({
  id: 'lemlist', tags: ['provider:lemlist'], maxStreams: 1, maxFetches: 1,
  streams: [
    defineStream({
      id: 'lemlist.activities', tags: ['resource:activities'], destination: lemlist_activitiesRaw,
      incremental: {
        ...activityWindow,
        plan(input) {
          const selection = activityWindow.plan(input)
          // Explicit backfills have their own namespace; reuse its completed interval frontier.
          if (input.range && input.state) {
            if (selection.to.getTime() < Date.parse(input.state.watermark)) {
              throw new IngestConfigError('Lemlist backfill upper bound precedes its committed interval frontier; use a new backfill ID for a narrower historical range.')
            }
            return { ...selection, from: new Date(Math.max(selection.from.getTime(), Date.parse(input.state.watermark) - 24 * 60 * 60 * 1000)) }
          }
          return selection
        },
      },
      batchSize: 500,
      async *read(context) {
        for (let from = context.selection.from; from < context.selection.to;) {
          const to = new Date(Math.min(from.getTime() + intervalMs, context.selection.to.getTime()))
          for await (const page of pages(context, 'activities', { from, to })) {
            yield { rows: rawRows(page, (item) => item._id) }
          }
          // Only an exhausted interval is a safe frontier. Offset pages remain mutable.
          const watermark = new Date(Math.max(to.getTime(), Date.parse(context.state?.watermark ?? to.toISOString()))).toISOString()
          yield { rows: [], state: { watermark }, id: `completed-interval:${from.toISOString()}/${to.toISOString()}` }
          from = to
        }
      },
    }),
    defineStream({
      id: 'lemlist.campaigns', tags: ['resource:campaigns'], destination: lemlist_campaignsRaw,
      incremental: campaignScan,
      async *read(context) {
        for await (const page of pages(context, 'campaigns')) yield { rows: rawRows(page, (item) => item._id) }
      },
    }),
  ],
})

async function* pages(context: FetchContext, resource: 'activities' | 'campaigns', window?: TimestampRange): AsyncGenerator<Item[]> {
  let offset = 0
  const seen = new Set<string>()
  while (true) {
    const url = new URL(`https://api.lemlist.com/api/${resource}`)
    url.searchParams.set('version', 'v2')
    url.searchParams.set('limit', String(pageSize))
    url.searchParams.set('offset', String(offset))
    if (window) {
      url.searchParams.set('minDate', window.from.toISOString())
      url.searchParams.set('maxDate', window.to.toISOString())
    } else {
      url.searchParams.set('sortBy', 'createdAt')
      url.searchParams.set('sortOrder', 'asc')
    }
    const items = await context.attempt(async (signal) => {
      const key = process.env.LEMLIST_API_KEY?.trim()
      if (!key) throw new IngestConfigError('Set LEMLIST_API_KEY.')
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
        headers: { Authorization: `Basic ${Buffer.from(`:${key}`).toString('base64')}` } })
      if (!response.ok) throw await HttpError.fromResponse(response)
      const result: unknown = await response.json()
      const values = resource === 'campaigns' && isObject(result) ? result.campaigns : result
      if (!Array.isArray(values) || !values.every(isItem)) throw new IngestConfigError(`Lemlist ${resource} response has no valid items.`)
      return values
    }, { label: `GET /${resource}` })
    if (items.length) {
      const identity = JSON.stringify(items.map((item) => item._id))
      if (seen.has(identity)) throw new IngestConfigError(`Lemlist ${resource} repeated a page.`)
      seen.add(identity)
      yield items
    }
    if (items.length < pageSize) return
    offset += items.length
  }
}

function isItem(value: unknown): value is Item {
  return isObject(value) && typeof value._id === 'string' && value._id.length > 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
