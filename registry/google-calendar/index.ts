import { definePipeline, defineStream, HttpError, rawRows, rawTable, type FetchContext } from '@chkit/plugin-ingest'

const database = 'default'
const calendarId = 'primary'
// Change these bounds to the events relevant to the project.
const pastDays = 365
const futureDays = 180

interface Event { id: string; [key: string]: unknown }
interface Page { items?: Event[]; nextPageToken?: string }

export const google_calendar_eventsRaw = rawTable({ database, name: 'google_calendar_events_raw' })

export const google_calendarPipeline = definePipeline({
  id: 'google-calendar', tags: ['provider:google-calendar'], maxFetches: 1,
  streams: [defineStream({ id: 'google-calendar.events', tags: ['resource:events'], destination: google_calendar_eventsRaw,
    async *read(context) {
      let pageToken: string | undefined
      const seen = new Set<string>()
      do {
        const page = await readPage(context, pageToken)
        if (!Array.isArray(page.items ?? [])) throw new Error('Calendar items are not an array')
        if (page.items?.length) yield { rows: rawRows(page.items, (event) => JSON.stringify([calendarId, event.id])) }
        pageToken = page.nextPageToken
        if (pageToken && seen.has(pageToken)) throw new Error('Calendar repeated a page token')
        if (pageToken) seen.add(pageToken)
      } while (pageToken)
    },
  })],
})

async function readPage(context: FetchContext, pageToken?: string): Promise<Page> {
  return context.attempt(async (signal) => {
    const token = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN
    if (!token) throw new Error('Set GOOGLE_CALENDAR_ACCESS_TOKEN')
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`)
    const timeMin = new Date(Date.now() - pastDays * 86_400_000).toISOString()
    const timeMax = new Date(Date.now() + futureDays * 86_400_000).toISOString()
    for (const [key, value] of Object.entries({ singleEvents: 'true', showDeleted: 'true', maxResults: '250', timeMin, timeMax })) url.searchParams.set(key, value)
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const response = await fetch(url, { signal, headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw await HttpError.fromResponse(response)
    return await response.json() as Page
  }, { label: 'GET calendar events' })
}
