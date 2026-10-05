import { cursorState, IngestConfigError, rawRows, rawTable, type ReadContext } from '@chkit/plugin-ingest'

import { readMeetingPages, readTranscript, type CirclebackClientDeps } from '../client.js'
import { circlebackConfig, type CirclebackReaderConfig } from '../config.js'

interface UnavailableTranscript { id: string; status: 'forbidden' | 'not_found'; checkedAt: string }
interface ScanCycle { startedAt: string; completedMeetingIds: string[] }
interface ScanState { scope: string; completedAt: string | null; scan: ScanCycle | null; unavailableTranscripts: UnavailableTranscript[] }

export const circleback_meetingsRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_meetings_raw' })

/** One resource collection; parent IDs below are recovery positions, never individual streams. */
export async function* readMeetings(context: ReadContext<ScanState | undefined, ScanState>, deps: CirclebackClientDeps) {
  const unavailable = new Map(context.state?.unavailableTranscripts.map((item) => [item.id, item]) ?? [])
  const completed = new Set(context.state?.scan?.completedMeetingIds ?? [])
  const startedAt = context.state?.scan?.startedAt ?? context.cutoff.toISOString()
  const scope = sourceScope(deps.config)
  for await (const meetings of readMeetingPages(context, deps)) {
    for (const meeting of meetings) {
      // Restart mutable listing pages; skip only sink-acknowledged enrichment in the active cycle.
      if (completed.has(meeting.id)) continue
      if (completed.size >= deps.config.maxRetainedMeetings) throw new IngestConfigError('Circleback scan exceeds maxRetainedMeetings; raise that source setting before resuming.')
      const outcome = await context.attempt((signal) => readTranscript(meeting.id, signal, deps), { label: 'GET meeting transcript' })
      if (outcome.status === 'available') unavailable.delete(meeting.id)
      else unavailable.set(meeting.id, { id: meeting.id, status: outcome.status, checkedAt: context.cutoff.toISOString() })
      if (unavailable.size > deps.config.maxRetainedMeetings) throw new IngestConfigError('Circleback unavailable diagnostics exceed maxRetainedMeetings; resolve old entries or raise that source setting.')
      completed.add(meeting.id)
      yield {
        rows: rawRows([{ ...meeting, transcript: outcome.transcript, _chkit_transcript_status: outcome.status }], (item) => item.id),
        state: { scope, completedAt: context.state?.completedAt ?? null,
          scan: { startedAt, completedMeetingIds: [...completed] }, unavailableTranscripts: [...unavailable.values()] },
      }
    }
  }
  // Next run rechecks every listed meeting; absent unavailable IDs remain diagnostics, not pending work.
  yield { rows: [], state: { scope, completedAt: context.cutoff.toISOString(), scan: null,
    unavailableTranscripts: [...unavailable.values()] }, id: `completed-scan:${startedAt}` }
}

export function createMeetingStrategy(config: CirclebackReaderConfig) {
  return cursorState<ScanState>({
    id: 'circleback.meetings.full_scan', version: 2,
    parse: (raw) => parseState(raw, config),
  })
}

function parseState(raw: unknown, config: CirclebackReaderConfig): ScanState {
  const scope = sourceScope(config)
  if (!isObject(raw) || raw.scope !== scope || (raw.completedAt !== null && !isTimestamp(raw.completedAt)) ||
    (raw.scan !== null && !isScan(raw.scan, config.maxRetainedMeetings)) || !Array.isArray(raw.unavailableTranscripts) ||
    raw.unavailableTranscripts.length > config.maxRetainedMeetings || !raw.unavailableTranscripts.every(isUnavailable) ||
    new Set(raw.unavailableTranscripts.map((item) => item.id)).size !== raw.unavailableTranscripts.length) {
    throw new IngestConfigError('Circleback checkpoint is invalid or its source/filter scope changed; use a new stream identity for a different source.')
  }
  return { scope, completedAt: raw.completedAt, scan: raw.scan, unavailableTranscripts: raw.unavailableTranscripts }
}

function sourceScope(config: CirclebackReaderConfig): string {
  return JSON.stringify({ sourceIdentity: config.sourceIdentity, ownership: config.ownership })
}

function isScan(value: unknown, max: number): value is ScanCycle {
  return isObject(value) && isTimestamp(value.startedAt) && Array.isArray(value.completedMeetingIds) &&
    value.completedMeetingIds.length <= max && value.completedMeetingIds.every((id: unknown) => typeof id === 'string' && id.length > 0) &&
    new Set(value.completedMeetingIds).size === value.completedMeetingIds.length
}

function isUnavailable(value: unknown): value is UnavailableTranscript {
  return isObject(value) && typeof value.id === 'string' && value.id.length > 0 &&
    (value.status === 'forbidden' || value.status === 'not_found') && isTimestamp(value.checkedAt)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
