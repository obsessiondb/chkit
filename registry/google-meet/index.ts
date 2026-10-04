import { definePipeline, defineStream, HttpError, rawRows, rawTable, type FetchContext } from '@chkit/plugin-ingest'

const database = 'default'
// Pick a range that includes conferences whose transcripts may still be processing.
const lookbackDays = 30
const baseUrl = 'https://meet.googleapis.com/v2'

interface Named { name: string; [key: string]: unknown }

export const google_meet_conferencesRaw = rawTable({ database, name: 'google_meet_conferences_raw' })
export const google_meet_transcriptsRaw = rawTable({ database, name: 'google_meet_transcripts_raw' })

export const google_meetPipeline = definePipeline({
  id: 'google-meet', tags: ['provider:google-meet'], maxStreams: 1, maxFetches: 1,
  streams: [
    defineStream({ id: 'google-meet.conferences', tags: ['resource:conferences'], destination: google_meet_conferencesRaw,
      async *read(context) {
        for await (const page of conferences(context)) yield { rows: rawRows(page, (item) => item.name) }
      },
    }),
    defineStream({ id: 'google-meet.transcripts', tags: ['resource:transcripts'], destination: google_meet_transcriptsRaw,
      async *read(context) {
        for await (const page of conferences(context)) {
          for (const conference of page) {
            for await (const transcripts of list<Named>(context, `${conference.name}/transcripts`, 'transcripts')) {
              for (const transcript of transcripts) {
                const entries: unknown[] = []
                for await (const part of list<unknown>(context, `${transcript.name}/entries`, 'transcriptEntries')) entries.push(...part)
                yield { rows: rawRows([{ ...transcript, conference_name: conference.name, entries }], (item) => item.name) }
              }
            }
          }
        }
      },
    }),
  ],
})

function conferences(context: FetchContext): AsyncGenerator<Named[]> {
  const from = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()
  const to = new Date().toISOString()
  return list<Named>(context, `conferenceRecords?filter=${encodeURIComponent(`start_time>="${from}" AND start_time<="${to}"`)}`, 'conferenceRecords')
}

async function* list<T>(context: FetchContext, path: string, field: string): AsyncGenerator<T[]> {
  let pageToken: string | undefined
  const seen = new Set<string>()
  do {
    const page = await context.attempt(async (signal) => {
      const token = process.env.GOOGLE_MEET_ACCESS_TOKEN
      if (!token) throw new Error('Set GOOGLE_MEET_ACCESS_TOKEN')
      const url = new URL(`${baseUrl}/${path}`)
      url.searchParams.set('pageSize', '100')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const response = await fetch(url, { signal, headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) throw await HttpError.fromResponse(response)
      return await response.json() as Record<string, unknown>
    }, { label: `GET ${field}` })
    const items = page[field]
    if (items !== undefined && !Array.isArray(items)) throw new Error(`Meet ${field} is not an array`)
    if (Array.isArray(items) && items.length) yield items as T[]
    pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : undefined
    if (pageToken && seen.has(pageToken)) throw new Error(`Meet repeated ${field} page token`)
    if (pageToken) seen.add(pageToken)
  } while (pageToken)
}
