import { IngestConfigError, rawRows, rawTable, type ReadContext, type SourceChunk } from '@chkit/plugin-ingest'

import { isObject, optionalString, optionalTimestamp, readCollection, timestamp, type CollectionCursor, type GoogleMeetClientDeps, type Named } from '../client.js'
import { googleMeetConfig, type GoogleMeetReaderConfig } from '../config.js'

const hourMs = 3_600_000

export type Resource = 'conferences' | 'transcripts' | 'transcript-entries' | 'participants' | 'participant-sessions' | 'recordings'
interface Bounds { from?: string; to?: string }
interface Window extends CollectionCursor { from: string; to: string; phase: 'ended' | 'ongoing' }
export interface MeetState { scope: string; watermark?: string; bounds?: Bounds; window?: Window }
export type MeetSelection = { from: Date | undefined; to: Date | undefined } | undefined
type MeetContext = ReadContext<MeetSelection, MeetState>
type MeetChunk = SourceChunk<Record<string, unknown>, MeetState>

export const google_meet_conferencesRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_conferences_raw' })
export const google_meet_transcriptsRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_transcripts_raw' })
export const google_meet_transcriptEntriesRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_transcript_entries_raw' })
export const google_meet_participantsRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_participants_raw' })
export const google_meet_participantSessionsRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_participant_sessions_raw' })
export const google_meet_recordingsRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_recordings_raw' })

// Every resource independently discovers conferences and replays unfinished parent pages.
export async function* readResource(context: MeetContext, resource: Resource, deps: GoogleMeetClientDeps): AsyncGenerator<MeetChunk> {
  const scope = meetScope(deps.config)
  let state: MeetState = context.state ?? { scope }
  const requestedBounds = context.selection?.from || context.selection?.to
    ? { from: context.selection.from?.toISOString(), to: context.selection.to?.toISOString() }
    : undefined
  if (requestedBounds && state.bounds && JSON.stringify(requestedBounds) !== JSON.stringify(state.bounds)) throw new IngestConfigError('Meet backfill bounds changed. Use a new backfill ID.')
  if (requestedBounds && state.watermark && !state.bounds) throw new IngestConfigError('Meet checkpoint was created without date bounds. Use a new backfill ID.')
  state = { ...state, bounds: state.bounds ?? requestedBounds }
  if (!state.window) {
    const to = state.bounds?.to ?? context.cutoff.toISOString()
    const anchor = state.watermark ?? to
    const from = state.bounds?.from ?? new Date(Date.parse(anchor) - deps.config.lookbackHours * hourMs).toISOString()
    if (Date.parse(from) > Date.parse(to) || state.watermark && Date.parse(state.watermark) > Date.parse(to)) throw new IngestConfigError('Meet cutoff precedes its committed range.')
    state = { ...state, window: { from, to, phase: 'ended' } }
    yield progress(state)
  }
  while (state.window) {
    const window = state.window
    const filter = window.phase === 'ended'
      ? `end_time>="${window.from}" AND end_time<="${window.to}"`
      : `end_time IS NULL AND start_time<="${window.to}"`
    for await (const page of readCollection(context, 'conferenceRecords', 'conferenceRecords', deps, { filter, initial: { pageToken: window.pageToken, recoveryCount: window.recoveryCount }, pageSize: deps.config.pageSize })) {
      if (!page.metadata?.reset) {
        for (const conference of page.items) {
          if (resource === 'conferences') yield { rows: rawRows([conference], (item) => JSON.stringify([deps.config.sourceId, item.name])) }
          else yield* readChildren(context, resource, conference, deps)
        }
      }
      state = page.next
        ? { ...state, window: { from: window.from, to: window.to, phase: window.phase, ...page.next } }
        : window.phase === 'ended' && !state.bounds
          ? { ...state, window: { from: window.from, to: window.to, phase: 'ongoing' } }
          : { scope, bounds: state.bounds, watermark: window.to }
      // Flush all child rows before advancing discovery. Partial pages replay on resume.
      yield progress(state)
    }
  }
}

export function parseMeetState(raw: unknown, config: GoogleMeetReaderConfig): MeetState {
  const scope = meetScope(config)
  if (!isObject(raw) || raw.scope !== scope || 'pending' in raw || 'cycle' in raw || 'active' in raw) throw new IngestConfigError('Meet checkpoint scope or format changed. Migrate the state explicitly or use a new stream ID.')
  const state: MeetState = { scope, watermark: optionalTimestamp(raw.watermark, 'watermark') }
  if (raw.bounds !== undefined) {
    if (!isObject(raw.bounds)) throw new IngestConfigError('Meet backfill bounds are invalid.')
    state.bounds = { from: optionalTimestamp(raw.bounds.from, 'backfill from'), to: optionalTimestamp(raw.bounds.to, 'backfill to') }
    if (!state.bounds.from && !state.bounds.to || state.bounds.from && state.bounds.to && Date.parse(state.bounds.from) > Date.parse(state.bounds.to)) throw new IngestConfigError('Meet backfill bounds are invalid.')
  }
  if (raw.window !== undefined) {
    const window = raw.window
    if (!isObject(window) || window.phase !== 'ended' && window.phase !== 'ongoing' || state.bounds && window.phase === 'ongoing') throw new IngestConfigError('Meet discovery window is invalid.')
    const from = timestamp(window.from, 'window from')
    const to = timestamp(window.to, 'window to')
    if (Date.parse(from) > Date.parse(to) || state.bounds?.from && from !== state.bounds.from || state.bounds?.to && to !== state.bounds.to) throw new IngestConfigError('Meet discovery bounds are invalid.')
    if (window.recoveryCount !== undefined && window.recoveryCount !== 1) throw new IngestConfigError('Meet recovery count must be one.')
    state.window = { from, to, phase: window.phase, pageToken: optionalString(window.pageToken, 'pageToken'), recoveryCount: window.recoveryCount }
  }
  if (!state.window && !state.watermark) throw new IngestConfigError('Meet checkpoint has no discovery progress.')
  return state
}

async function* readChildren(context: MeetContext, resource: Exclude<Resource, 'conferences'>, conference: Named, deps: GoogleMeetClientDeps): AsyncGenerator<MeetChunk> {
  const collection = resource === 'transcript-entries' ? 'transcripts' : resource === 'participant-sessions' ? 'participants' : resource
  for await (const page of readCollection(context, `${conference.name}/${collection}`, collection, deps)) {
    if (resource === 'transcript-entries' || resource === 'participant-sessions') {
      const child = resource === 'transcript-entries' ? 'entries' : 'participantSessions'
      const field = resource === 'transcript-entries' ? 'transcriptEntries' : child
      const parentField = resource === 'transcript-entries' ? 'transcript_name' : 'participant_name'
      for (const parent of page.items) {
        for await (const children of readCollection(context, `${parent.name}/${child}`, field, deps)) {
          yield { rows: rawRows(children.items.map((item) => ({ ...item, conference_name: conference.name, [parentField]: parent.name })), (item) => JSON.stringify([deps.config.sourceId, item.name])) }
        }
      }
      if (!page.items.length) yield { rows: [] }
    } else {
      yield { rows: rawRows(page.items.map((item) => ({ ...item, conference_name: conference.name })), (item) => JSON.stringify([deps.config.sourceId, item.name])) }
    }
  }
}

function progress(state: MeetState): MeetChunk {
  return { rows: [], state, id: 'meet-discovery-progress' }
}

function meetScope(config: GoogleMeetReaderConfig): string {
  return JSON.stringify([config.sourceId, config.lookbackHours, config.pageSize])
}
