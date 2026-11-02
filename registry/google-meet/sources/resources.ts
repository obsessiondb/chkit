import { rawRows, rawTable, type ReadContext, type SourceChunk } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { createGoogleMeetClient, type CollectionCursor, type GoogleMeetClient, type Named } from '../client.js'
import { googleMeetConfig, type GoogleMeetReaderConfig } from '../config.js'

const hourMs = 3_600_000
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'must be a timestamp')
const stateSchema = z.strictObject({
  scope: z.string(),
  watermark: timestamp.optional(),
  bounds: z.strictObject({ from: timestamp.optional(), to: timestamp.optional() }).optional(),
  window: z.strictObject({
    from: timestamp,
    to: timestamp,
    phase: z.enum(['ended', 'ongoing']),
    pageToken: z.string().refine((value) => value.trim() !== '', 'must not be blank').optional(),
    recoveryCount: z.literal(1).optional(),
  }).optional(),
})

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
export async function* readResource(context: MeetContext, resource: Resource, config: GoogleMeetReaderConfig): AsyncGenerator<MeetChunk> {
  const client = createGoogleMeetClient(context, config)
  const scope = meetScope(client.settings)
  let state: MeetState = context.state ?? { scope }
  const requestedBounds = context.selection?.from || context.selection?.to
    ? { from: context.selection.from?.toISOString(), to: context.selection.to?.toISOString() }
    : undefined
  if (requestedBounds && state.bounds && JSON.stringify(requestedBounds) !== JSON.stringify(state.bounds)) throw new Error('Meet backfill bounds changed. Use a new backfill ID.')
  if (requestedBounds && state.watermark && !state.bounds) throw new Error('Meet checkpoint was created without date bounds. Use a new backfill ID.')
  state = { ...state, bounds: state.bounds ?? requestedBounds }
  if (!state.window) {
    const to = state.bounds?.to ?? context.cutoff.toISOString()
    const anchor = state.watermark ?? to
    const lowerBound = state.bounds?.from ? new Date(state.bounds.from) : new Date(Date.parse(anchor) - client.settings.lookbackHours * hourMs)
    if (!Number.isFinite(lowerBound.getTime())) throw new Error('Meet lookbackHours places the lower bound outside the Date range.')
    const from = state.bounds?.from ?? lowerBound.toISOString()
    if (Date.parse(from) > Date.parse(to) || state.watermark && Date.parse(state.watermark) > Date.parse(to)) throw new Error('Meet cutoff precedes its committed range.')
    state = { ...state, window: { from, to, phase: 'ended' } }
    yield progress(state)
  }
  while (state.window) {
    const window = state.window
    const filter = window.phase === 'ended'
      ? `end_time>="${window.from}" AND end_time<="${window.to}"`
      : `end_time IS NULL AND start_time<="${window.to}"`
    for await (const page of client.collection('conferenceRecords', 'conferenceRecords', { filter, initial: { pageToken: window.pageToken, recoveryCount: window.recoveryCount }, pageSize: client.settings.pageSize })) {
      if (!page.metadata?.reset) {
        for (const conference of page.items) {
          if (resource === 'conferences') yield { rows: rawRows([conference], (item) => JSON.stringify([client.settings.sourceId, item.name])) }
          else yield* readChildren(client, resource, conference)
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
  const parsed = stateSchema.safeParse(raw)
  if (!parsed.success || parsed.data.scope !== scope) {
    throw new Error('Meet checkpoint scope or format changed. Migrate the state explicitly or use a new stream ID.', { cause: parsed.error })
  }
  const { bounds, window, watermark } = parsed.data
  if (bounds && (!bounds.from && !bounds.to || bounds.from && bounds.to && Date.parse(bounds.from) > Date.parse(bounds.to))) throw new Error('Meet backfill bounds are invalid.')
  if (window) {
    if (bounds && window.phase === 'ongoing') throw new Error('Meet discovery window is invalid.')
    if (Date.parse(window.from) > Date.parse(window.to) || bounds?.from && window.from !== bounds.from || bounds?.to && window.to !== bounds.to) throw new Error('Meet discovery bounds are invalid.')
  }
  if (!window && !watermark) throw new Error('Meet checkpoint has no discovery progress.')
  return { scope, watermark, bounds, window }
}

async function* readChildren(client: GoogleMeetClient, resource: Exclude<Resource, 'conferences'>, conference: Named): AsyncGenerator<MeetChunk> {
  const collection = resource === 'transcript-entries' ? 'transcripts' : resource === 'participant-sessions' ? 'participants' : resource
  for await (const page of client.collection(`${conference.name}/${collection}`, collection)) {
    if (resource === 'transcript-entries' || resource === 'participant-sessions') {
      const child = resource === 'transcript-entries' ? 'entries' : 'participantSessions'
      const field = resource === 'transcript-entries' ? 'transcriptEntries' : child
      const parentField = resource === 'transcript-entries' ? 'transcript_name' : 'participant_name'
      for (const parent of page.items) {
        for await (const children of client.collection(`${parent.name}/${child}`, field)) {
          yield { rows: rawRows(children.items.map((item) => ({ ...item, conference_name: conference.name, [parentField]: parent.name })), (item) => JSON.stringify([client.settings.sourceId, item.name])) }
        }
      }
      if (!page.items.length) yield { rows: [] }
    } else {
      yield { rows: rawRows(page.items.map((item) => ({ ...item, conference_name: conference.name })), (item) => JSON.stringify([client.settings.sourceId, item.name])) }
    }
  }
}

function progress(state: MeetState): MeetChunk {
  return { rows: [], state, id: 'meet-discovery-progress' }
}

function meetScope(config: Pick<GoogleMeetReaderConfig, 'sourceId' | 'lookbackHours' | 'pageSize'>): string {
  return JSON.stringify([config.sourceId, config.lookbackHours, config.pageSize])
}
