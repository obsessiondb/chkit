import { definePipeline, defineStream, HttpError, rawRows, rawTable } from '@chkit/plugin-ingest'

const database = 'default'
const baseUrl = 'https://circleback.ai/api'

interface Meeting { id: string; [key: string]: unknown }

export const circleback_meetingsRaw = rawTable({ database, name: 'circleback_meetings_raw' })

export const circlebackPipeline = definePipeline({
  id: 'circleback', tags: ['provider:circleback'], maxFetches: 1,
  streams: [defineStream({
    id: 'circleback.meetings', tags: ['resource:meetings'], destination: circleback_meetingsRaw,
    async *read(context) {
      let next: string | undefined = `${baseUrl}/meetings?ownership=All`
      const seen = new Set<string>()
      while (next) {
        if (seen.has(next)) throw new Error('Circleback repeated a page URL')
        seen.add(next)
        const current: string = next
        const response = await context.attempt((signal) => request(current, signal), { label: 'GET /meetings' })
        if (!response) throw new Error('Circleback returned no meetings response')
        const meetings = await response.json() as Meeting[]
        if (!Array.isArray(meetings)) throw new Error('Circleback meetings response is not an array')
        const rows = []
        for (const meeting of meetings) {
          if (!meeting.id) throw new Error('Circleback meeting has no ID')
          const transcript = await context.attempt(async (signal) => {
            const result = await request(`${baseUrl}/meeting/${encodeURIComponent(meeting.id)}/transcript`, signal, true)
            return result ? await result.json() : null
          }, { label: 'GET meeting transcript' })
          rows.push({ ...meeting, transcript })
        }
        if (rows.length) yield { rows: rawRows(rows, (meeting) => meeting.id) }
        next = response.headers.get('link')?.split(',').map((part) => /<([^>]+)>\s*;.*rel="?next"?/.exec(part)?.[1]).find(Boolean)
        if (next) next = new URL(next, current).toString()
      }
    },
  })],
})

async function request(url: string, signal: AbortSignal, optional = false): Promise<Response | null> {
  const token = process.env.CIRCLEBACK_API_KEY
  if (!token) throw new Error('Set CIRCLEBACK_API_KEY')
  const response = await fetch(url, { signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (optional && (response.status === 403 || response.status === 404)) return null
  if (!response.ok) throw await HttpError.fromResponse(response)
  return response
}
