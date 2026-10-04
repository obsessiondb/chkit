import { cursorState, definePipeline, defineStream, HttpError, IngestConfigError, rawRows, rawTable } from '@chkit/plugin-ingest'

const database = 'default'
const baseUrl = 'https://circleback.ai/api'
// Change the source identity and stream ID when switching authenticated accounts.
const sourceIdentity = 'circleback.primary'
const ownership = 'All'
const scope = JSON.stringify({ sourceIdentity, ownership })
// Bounds durable parent progress and unavailable diagnostics. Raise deliberately for larger accounts.
const maxRetainedMeetings = 10_000

interface Meeting { id: string; [key: string]: unknown }
interface UnavailableTranscript { id: string; status: 'forbidden' | 'not_found'; checkedAt: string }
interface ScanCycle { startedAt: string; completedMeetingIds: string[] }
interface ScanState { scope: string; completedAt: string | null; scan: ScanCycle | null; unavailableTranscripts: UnavailableTranscript[] }

export const circleback_meetingsRaw = rawTable({ database, name: 'circleback_meetings_raw' })

export const circlebackPipeline = definePipeline({
  id: 'circleback', tags: ['provider:circleback'], maxStreams: 1, maxFetches: 1,
  streams: [defineStream({
    id: 'circleback.meetings', tags: ['resource:meetings'], destination: circleback_meetingsRaw,
    incremental: cursorState<ScanState>({ id: 'circleback.meetings.full_scan', version: 2, parse: parseState }),
    // Candidate parent progress belongs to the corresponding loaded observation.
    batchSize: 1,
    async *read(context) {
      const unavailable = new Map(context.state?.unavailableTranscripts.map((item) => [item.id, item]) ?? [])
      const completed = new Set(context.state?.scan?.completedMeetingIds ?? [])
      const startedAt = context.state?.scan?.startedAt ?? context.cutoff.toISOString()
      let next: string | undefined = `${baseUrl}/meetings?ownership=${encodeURIComponent(ownership)}`
      const seen = new Set<string>()
      while (next) {
        if (seen.has(next)) throw new IngestConfigError('Circleback repeated a page URL.')
        seen.add(next)
        const current: string = next
        const page = await context.attempt(async (signal) => {
          const response = await request(current, signal)
          const meetings: unknown = await response.json()
          if (!Array.isArray(meetings) || !meetings.every(isMeeting)) throw new IngestConfigError('Circleback returned invalid meetings.')
          return { meetings, next: nextLink(response.headers.get('link'), current) }
        }, { label: 'GET /meetings' })
        for (const meeting of page.meetings) {
          // Pages restart from the beginning. Only sink-acknowledged parents are skipped in this cycle.
          if (completed.has(meeting.id)) continue
          if (completed.size >= maxRetainedMeetings) throw new IngestConfigError('Circleback scan exceeds maxRetainedMeetings; raise that source setting before resuming.')
          const outcome = await context.attempt(async (signal) => {
            const url = `${baseUrl}/meeting/${encodeURIComponent(meeting.id)}/transcript`
            const response = await request(url, signal, true)
            if (response.status === 403) return { transcript: null, status: 'forbidden' as const }
            if (response.status === 404) return { transcript: null, status: 'not_found' as const }
            return { transcript: await response.json(), status: 'available' as const }
          }, { label: 'GET meeting transcript' })
          if (outcome.status === 'available') unavailable.delete(meeting.id)
          else unavailable.set(meeting.id, { id: meeting.id, status: outcome.status, checkedAt: context.cutoff.toISOString() })
          if (unavailable.size > maxRetainedMeetings) throw new IngestConfigError('Circleback unavailable diagnostics exceed maxRetainedMeetings; resolve old entries or raise that source setting.')
          completed.add(meeting.id)
          // No assumption that a meeting timestamp tracks delayed transcript availability.
          yield {
            rows: rawRows([{ ...meeting, transcript: outcome.transcript, _chkit_transcript_status: outcome.status }], (item) => item.id),
            state: { scope, completedAt: context.state?.completedAt ?? null,
              scan: { startedAt, completedMeetingIds: [...completed] }, unavailableTranscripts: [...unavailable.values()] },
          }
        }
        next = page.next
      }
      // The next execution starts a fresh cycle and rechecks every accessible parent's latest data.
      // IDs absent from this listing remain unavailable diagnostics, not executable pending work.
      yield { rows: [], state: { scope, completedAt: context.cutoff.toISOString(), scan: null,
        unavailableTranscripts: [...unavailable.values()] }, id: `completed-scan:${startedAt}` }
    },
  })],
})

async function request(url: string, signal: AbortSignal, allowUnavailable = false): Promise<Response> {
  const token = process.env.CIRCLEBACK_API_KEY?.trim()
  if (!token) throw new IngestConfigError('Set CIRCLEBACK_API_KEY.')
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (allowUnavailable && (response.status === 403 || response.status === 404)) return response
  if (!response.ok) throw await HttpError.fromResponse(response)
  return response
}

function parseState(raw: unknown): ScanState {
  if (!isObject(raw) || raw.scope !== scope || (raw.completedAt !== null && !isTimestamp(raw.completedAt)) ||
    (raw.scan !== null && !isScan(raw.scan)) || !Array.isArray(raw.unavailableTranscripts) ||
    raw.unavailableTranscripts.length > maxRetainedMeetings || !raw.unavailableTranscripts.every(isUnavailable) ||
    new Set(raw.unavailableTranscripts.map((item) => item.id)).size !== raw.unavailableTranscripts.length) {
    throw new IngestConfigError('Circleback checkpoint is invalid or its source/filter scope changed; use a new stream identity for a different source.')
  }
  return { scope, completedAt: raw.completedAt, scan: raw.scan, unavailableTranscripts: raw.unavailableTranscripts }
}

function isScan(value: unknown): value is ScanCycle {
  return isObject(value) && isTimestamp(value.startedAt) && Array.isArray(value.completedMeetingIds) &&
    value.completedMeetingIds.length <= maxRetainedMeetings && value.completedMeetingIds.every((id: unknown) => typeof id === 'string' && id.length > 0) &&
    new Set(value.completedMeetingIds).size === value.completedMeetingIds.length
}

function isMeeting(value: unknown): value is Meeting {
  return isObject(value) && typeof value.id === 'string' && value.id.length > 0
}

function isUnavailable(value: unknown): value is UnavailableTranscript {
  return isMeeting(value) && (value.status === 'forbidden' || value.status === 'not_found') && isTimestamp(value.checkedAt)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function nextLink(header: string | null, current: string): string | undefined {
  const value = header?.split(',').map((part) => /<([^>]+)>\s*;.*rel="?next"?/.exec(part)?.[1]).find(Boolean)
  if (!value) return undefined
  const next = new URL(value, current)
  if (next.origin !== 'https://circleback.ai') throw new IngestConfigError('Circleback next page has an unexpected origin.')
  return next.toString()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
