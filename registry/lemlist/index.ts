import { definePipeline, defineStream, HttpError, rawRows, rawTable, type FetchContext } from '@chkit/plugin-ingest'

const database = 'default'
const pageSize = 100

interface Item { _id: string; [key: string]: unknown }

export const lemlist_activitiesRaw = rawTable({ database, name: 'lemlist_activities_raw' })
export const lemlist_campaignsRaw = rawTable({ database, name: 'lemlist_campaigns_raw' })

export const lemlistPipeline = definePipeline({
  id: 'lemlist', tags: ['provider:lemlist'], maxFetches: 1,
  streams: [
    defineStream({ id: 'lemlist.activities', tags: ['resource:activities'], destination: lemlist_activitiesRaw,
      async *read(context) {
        for await (const page of pages(context, 'activities')) yield { rows: rawRows(page, (item) => item._id) }
      },
    }),
    defineStream({ id: 'lemlist.campaigns', tags: ['resource:campaigns'], destination: lemlist_campaignsRaw,
      async *read(context) {
        for await (const page of pages(context, 'campaigns')) yield { rows: rawRows(page, (item) => item._id) }
      },
    }),
  ],
})

async function* pages(context: FetchContext, resource: 'activities' | 'campaigns'): AsyncGenerator<Item[]> {
  let offset = 0
  while (true) {
    const url = new URL(`https://api.lemlist.com/api/${resource}`)
    url.searchParams.set('version', 'v2')
    url.searchParams.set('limit', String(pageSize))
    url.searchParams.set('offset', String(offset))
    const result = await context.attempt(async (signal) => {
      const key = process.env.LEMLIST_API_KEY
      if (!key) throw new Error('Set LEMLIST_API_KEY')
      const response = await fetch(url, { signal, headers: { Authorization: `Basic ${Buffer.from(`:${key}`).toString('base64')}` } })
      if (!response.ok) throw await HttpError.fromResponse(response)
      return await response.json() as Item[] | { campaigns: Item[] }
    }, { label: `GET /${resource}` })
    const items = resource === 'campaigns' && !Array.isArray(result) ? result.campaigns : result
    if (!Array.isArray(items)) throw new Error(`Lemlist ${resource} response has no items`)
    if (items.length) yield items
    if (items.length < pageSize) return
    offset += items.length
  }
}
