import { IngestConfigError, rawRows, rawTable, type ReadContext, type SourceChunk } from '@chkit/plugin-ingest'

import { isObject, named, optionalString, optionalTimestamp, readPage, requiredString, timestamp, type GoogleMeetClientDeps, type Named } from '../client.js'
import { googleMeetConfig, type GoogleMeetReaderConfig } from '../config.js'

const dayMs = 86_400_000

export type Resource = 'conferences' | 'transcripts' | 'transcript-entries' | 'participants' | 'participant-sessions' | 'recordings'
interface PendingConference { name: string; expireTime?: string; checkedAt?: string }
interface Cycle {
  from: string
  to: string
  phase: 'ended' | 'ongoing' | 'parents'
  pageToken?: string
  /** Recovery debt for the unfinished discovery phase, across executions. */
  recoveryCount?: number
  parents: string[]
  parentIndex: number
}
interface ActiveParent {
  name: string
  transcriptPageToken?: string
  transcriptRecoveryCount?: number
  nextTranscriptPageToken?: string
  transcripts?: Named[]
  transcriptIndex: number
  entryPageToken?: string
  entryRecoveryCount?: number
  collection?: CollectionProgress
}
interface CollectionProgress {
  kind: 'participants' | 'recordings'
  pageToken?: string
  recoveryCount?: number
  nextPageToken?: string
  items?: Named[]
  index: number
  sessionPageToken?: string
  sessionRecoveryCount?: number
}
interface MeetState {
  scope: string
  watermark?: string
  bounds?: { from?: string; to?: string }
  pending: PendingConference[]
  cycle?: Cycle
  active?: ActiveParent
}
type MeetSelection = { from: Date | undefined; to: Date | undefined } | undefined
type MeetContext = ReadContext<MeetSelection, MeetState>
type MeetChunk = SourceChunk<Record<string, unknown>, MeetState>

export const google_meet_conferencesRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_conferences_raw' })
export const google_meet_transcriptsRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_transcripts_raw' })
export const google_meet_transcriptEntriesRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_transcript_entries_raw' })
export const google_meet_participantsRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_participants_raw' })
export const google_meet_participantSessionsRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_participant_sessions_raw' })
export const google_meet_recordingsRaw = rawTable({ database: googleMeetConfig.database, name: 'google_meet_recordings_raw' })

// Resource streams share traversal code, while every stream owns its journaled work queue.
export async function* readResource(context: MeetContext, resource: Resource, deps: GoogleMeetClientDeps): AsyncGenerator<MeetChunk> {
  const { sourceId, lookbackDays, overlapDays, windowDays } = deps.config
  const scope = meetScope(deps.config)
  let state: MeetState = context.state ?? { scope, pending: [] }
  const requestedBounds = context.selection?.from || context.selection?.to
    ? { from: context.selection.from?.toISOString(), to: context.selection.to?.toISOString() }
    : undefined
  if (requestedBounds && state.bounds && JSON.stringify(requestedBounds) !== JSON.stringify(state.bounds)) throw new IngestConfigError('Meet backfill bounds changed. Use a new backfill ID.')
  if (requestedBounds && state.watermark && !state.bounds) throw new IngestConfigError('Meet checkpoint was created without date bounds. Use a new backfill ID.')
  state = { ...state, bounds: state.bounds ?? requestedBounds }
  const seen = new Map<string, Set<string>>()
  if (!state.cycle) {
    const expired = state.pending.filter((parent) => parent.expireTime && Date.parse(parent.expireTime) <= context.cutoff.getTime())
    if (expired.some((parent) => !parent.checkedAt)) throw new IngestConfigError('Meet pending conference expired before a complete artifact read. Historical API coverage cannot be recovered; review and migrate the checkpoint explicitly.')
    const upper = state.bounds?.to ? Date.parse(state.bounds.to) : context.cutoff.getTime()
    const anchor = state.watermark ? Date.parse(state.watermark) : state.bounds?.from ? Date.parse(state.bounds.from) : upper - lookbackDays * dayMs
    const to = Math.min(state.bounds?.to ? Date.parse(state.bounds.to) : context.cutoff.getTime(), anchor + windowDays * dayMs)
    if (to < anchor) throw new IngestConfigError('Meet cutoff precedes its committed watermark.')
    state = {
      ...state, pending: state.pending.filter((parent) => !expired.includes(parent)),
      cycle: { from: new Date(state.watermark ? Math.max(state.bounds?.from ? Date.parse(state.bounds.from) : -Infinity, anchor - overlapDays * dayMs) : anchor).toISOString(), to: new Date(to).toISOString(), phase: 'ended', parents: [], parentIndex: 0 },
    }
    yield checkpoint(state)
  }
  while (state.cycle) {
    const cycle = state.cycle
    if (cycle.phase !== 'parents') {
      const filter = cycle.phase === 'ended'
        ? `end_time>="${cycle.from}" AND end_time<="${cycle.to}"`
        : `end_time IS NULL AND start_time<="${cycle.to}"`
      const page = await readPage(context, 'conferenceRecords', 'conferenceRecords', cycle.pageToken, filter, deps)
      if ('reset' in page) {
        const recoveryCount = nextRecoveryCount(cycle.recoveryCount, `discovery:${cycle.phase}`)
        seen.delete(`discovery:${cycle.phase}`)
        state = { ...state, cycle: { ...cycle, pageToken: undefined, recoveryCount } }
        yield checkpoint(state)
        continue
      }
      checkProgress(seen, `discovery:${cycle.phase}`, cycle.pageToken, page.nextPageToken)
      const pending = mergeParents(state.pending, page.items, deps.config.maxPendingConferences)
      state = { ...state, pending, cycle: page.nextPageToken
        ? { ...cycle, pageToken: page.nextPageToken }
        : cycle.phase === 'ended' && !state.bounds
          ? { ...cycle, phase: 'ongoing', pageToken: undefined, recoveryCount: undefined }
          : { ...cycle, phase: 'parents', pageToken: undefined, recoveryCount: undefined, parents: pending.map((parent) => parent.name) },
      }
      const rows = resource === 'conferences' ? rawRows(page.items, (item) => JSON.stringify([sourceId, item.name])) : []
      yield rows.length ? { rows, state } : checkpoint(state)
      continue
    }
    if (resource === 'conferences' || cycle.parentIndex === cycle.parents.length) {
      state = { scope, bounds: state.bounds, watermark: cycle.to, pending: resource === 'conferences' ? [] : state.pending }
      yield checkpoint(state)
      return
    }
    const name = cycle.parents[cycle.parentIndex]
    if (!name) throw new IngestConfigError('Meet parent position is invalid.')
    const parent = state.pending.find((item) => item.name === name)
    if (!parent) throw new IngestConfigError('Meet pending parent is missing.')
    if (parent.expireTime && Date.parse(parent.expireTime) <= context.cutoff.getTime()) {
      throw new IngestConfigError(`Meet ${name} expired during unfinished artifact work. Review the coverage gap and migrate the checkpoint explicitly.`)
    }
    const active: ActiveParent = state.active ?? { name, transcriptIndex: 0 }
    if (resource === 'participants' || resource === 'participant-sessions' || resource === 'recordings') {
      const chunk = await readAttendanceOrRecordings(context, resource, state, active, seen, deps)
      state = chunk.state
      yield chunk.rows.length ? chunk : checkpoint(state)
      continue
    }
    if (active.transcripts === undefined) {
      const path = `${name}/transcripts`
      const page = await readPage(context, path, 'transcripts', active.transcriptPageToken, undefined, deps)
      if ('reset' in page) {
        const transcriptRecoveryCount = nextRecoveryCount(active.transcriptRecoveryCount, path)
        seen.delete(path)
        state = { ...state, active: { name, transcriptIndex: 0, transcriptRecoveryCount } }
        yield checkpoint(state)
        continue
      }
      checkProgress(seen, path, active.transcriptPageToken, page.nextPageToken)
      if (resource === 'transcripts') {
        state = page.nextPageToken
          ? { ...state, active: { name, transcriptIndex: 0, transcriptPageToken: page.nextPageToken, transcriptRecoveryCount: active.transcriptRecoveryCount } }
          : finishParent(state, name, cycle.to)
        const rows = rawRows(page.items.map((item) => ({ ...item, conference_name: name })), (item) => JSON.stringify([sourceId, item.name]))
        yield rows.length ? { rows, state } : checkpoint(state)
      } else {
        state = { ...state, active: { ...active, transcripts: page.items, nextTranscriptPageToken: page.nextPageToken } }
        yield checkpoint(state)
      }
      continue
    }
    const transcript = active.transcripts[active.transcriptIndex]
    if (!transcript) {
      state = active.nextTranscriptPageToken
        ? { ...state, active: { name, transcriptIndex: 0, transcriptPageToken: active.nextTranscriptPageToken, transcriptRecoveryCount: active.transcriptRecoveryCount } }
        : finishParent(state, name, cycle.to)
      yield checkpoint(state)
      continue
    }
    const path = `${transcript.name}/entries`
    const page = await readPage(context, path, 'transcriptEntries', active.entryPageToken, undefined, deps)
    if ('reset' in page) {
      const entryRecoveryCount = nextRecoveryCount(active.entryRecoveryCount, path)
      seen.delete(path)
      state = { ...state, active: { ...active, entryPageToken: undefined, entryRecoveryCount } }
      yield checkpoint(state)
      continue
    }
    checkProgress(seen, path, active.entryPageToken, page.nextPageToken)
    state = { ...state, active: page.nextPageToken
      ? { ...active, entryPageToken: page.nextPageToken }
      // Entry recovery debt clears only with acknowledgement of its terminal page.
      : { ...active, entryPageToken: undefined, entryRecoveryCount: undefined, transcriptIndex: active.transcriptIndex + 1 },
    }
    const rows = rawRows(page.items.map((item) => ({ ...item, conference_name: name, transcript_name: transcript.name })), (item) => JSON.stringify([sourceId, item.name]))
    yield rows.length ? { rows, state } : checkpoint(state)
  }
}

export function parseMeetState(raw: unknown, config: GoogleMeetReaderConfig, resource?: Resource): MeetState {
  const scope = meetScope(config)
  const maxPendingConferences = config.maxPendingConferences
  if (!isObject(raw) || raw.scope !== scope || !Array.isArray(raw.pending)) throw new IngestConfigError('Meet checkpoint scope changed or pending queue is invalid. Migrate the state explicitly or use a new stream ID.')
  const pending = raw.pending.map((item: unknown) => {
    if (!isObject(item)) throw new IngestConfigError('Meet pending conference is invalid.')
    const name = requiredString(item.name, 'pending name')
    if (!/^conferenceRecords\/[^/?#]+$/.test(name)) throw new IngestConfigError('Meet pending parent name is invalid.')
    return { name, expireTime: optionalTimestamp(item.expireTime, 'pending expireTime'), checkedAt: optionalTimestamp(item.checkedAt, 'pending checkedAt') }
  })
  if (pending.length > maxPendingConferences || new Set(pending.map((item) => item.name)).size !== pending.length) throw new IngestConfigError('Meet pending queue is oversized or contains duplicate parents.')
  const state: MeetState = { scope, watermark: optionalTimestamp(raw.watermark, 'watermark'), pending }
  if (raw.bounds !== undefined) {
    if (!isObject(raw.bounds)) throw new IngestConfigError('Meet backfill bounds are invalid.')
    state.bounds = { from: optionalTimestamp(raw.bounds.from, 'backfill from'), to: optionalTimestamp(raw.bounds.to, 'backfill to') }
    if (state.bounds.from && state.bounds.to && Date.parse(state.bounds.from) > Date.parse(state.bounds.to)) throw new IngestConfigError('Meet backfill bounds are reversed.')
  }
  if (raw.cycle !== undefined) {
    const cycle = raw.cycle
    if (!isObject(cycle) || !['ended', 'ongoing', 'parents'].includes(String(cycle.phase)) || !Array.isArray(cycle.parents)) throw new IngestConfigError('Meet cycle is invalid.')
    const phase = cycle.phase
    if (phase !== 'ended' && phase !== 'ongoing' && phase !== 'parents') throw new IngestConfigError('Meet cycle phase is invalid.')
    const from = timestamp(cycle.from, 'cycle from')
    const to = timestamp(cycle.to, 'cycle to')
    if (Date.parse(from) > Date.parse(to)) throw new IngestConfigError('Meet cycle bounds are reversed.')
    const parents = cycle.parents.map((name: unknown) => requiredString(name, 'cycle parent'))
    const parentIndex = position(cycle.parentIndex, parents.length, 'parentIndex')
    if (new Set(parents).size !== parents.length || parents.some((name) => !pending.some((parent) => parent.name === name))) throw new IngestConfigError('Meet cycle references an invalid parent.')
    const recoveryCount = parseRecoveryCount(cycle.recoveryCount)
    if (phase === 'parents' && recoveryCount !== undefined) throw new IngestConfigError('Meet completed discovery still has recovery debt.')
    state.cycle = { from, to, phase, parents, parentIndex, pageToken: optionalString(cycle.pageToken, 'cycle pageToken'), recoveryCount }
  }
  if (raw.active !== undefined) {
    const active = raw.active
    if (!isObject(active) || state.cycle?.phase !== 'parents') throw new IngestConfigError('Meet active parent has no parent cycle.')
    const name = requiredString(active.name, 'active parent')
    if (name !== state.cycle.parents[state.cycle.parentIndex]) throw new IngestConfigError('Meet active parent does not match its position.')
    if (active.transcripts !== undefined && !Array.isArray(active.transcripts)) throw new IngestConfigError('Meet active transcripts are invalid.')
    const transcripts = active.transcripts?.map((item: unknown) => named(item))
    if (transcripts && transcripts.length > 100) throw new IngestConfigError('Meet active transcript page is oversized.')
    if (transcripts?.some((item) => !item.name.startsWith(`${name}/transcripts/`) || item.name.slice(`${name}/transcripts/`.length).includes('/'))) throw new IngestConfigError('Meet active transcript belongs to another parent.')
    const transcriptIndex = position(active.transcriptIndex, transcripts?.length ?? 0, 'transcriptIndex')
    const transcriptPageToken = optionalString(active.transcriptPageToken, 'transcriptPageToken')
    const nextTranscriptPageToken = optionalString(active.nextTranscriptPageToken, 'nextTranscriptPageToken')
    const entryPageToken = optionalString(active.entryPageToken, 'entryPageToken')
    const transcriptRecoveryCount = parseRecoveryCount(active.transcriptRecoveryCount)
    const entryRecoveryCount = parseRecoveryCount(active.entryRecoveryCount)
    if ((entryPageToken !== undefined || entryRecoveryCount !== undefined) && !transcripts?.[transcriptIndex]) throw new IngestConfigError('Meet entry progress has no active transcript.')
    if (nextTranscriptPageToken !== undefined && transcripts === undefined) throw new IngestConfigError('Meet next transcript page has no cached transcript page.')
    const hasTranscriptWork = transcripts !== undefined || transcriptIndex !== 0 || transcriptPageToken !== undefined || nextTranscriptPageToken !== undefined || entryPageToken !== undefined || transcriptRecoveryCount !== undefined || entryRecoveryCount !== undefined
    if (resource === 'conferences' || (resource !== undefined && resource !== 'transcripts' && resource !== 'transcript-entries' && hasTranscriptWork) ||
      (resource === 'transcripts' && (transcripts !== undefined || transcriptIndex !== 0 || nextTranscriptPageToken !== undefined || entryPageToken !== undefined || entryRecoveryCount !== undefined))) throw new IngestConfigError('Meet transcript traversal belongs to another resource stream.')
    const collection = active.collection === undefined ? undefined : parseCollection(active.collection, name, resource)
    if (collection && hasTranscriptWork) throw new IngestConfigError('Meet active parent mixes resource traversal state.')
    state.active = { name, transcripts, transcriptIndex, transcriptPageToken, nextTranscriptPageToken, entryPageToken, transcriptRecoveryCount, entryRecoveryCount, collection }
  }
  return state
}

async function readAttendanceOrRecordings(context: MeetContext, resource: 'participants' | 'participant-sessions' | 'recordings', state: MeetState, active: ActiveParent, seen: Map<string, Set<string>>, deps: GoogleMeetClientDeps): Promise<MeetChunk & { state: MeetState }> {
  if (!state.cycle) throw new IngestConfigError('Meet child collection has no cycle.')
  const kind = resource === 'recordings' ? 'recordings' : 'participants'
  const collection = active.collection ?? { kind, index: 0 }
  if (collection.items === undefined) {
    const path = `${active.name}/${kind}`
    const page = await readPage(context, path, kind, collection.pageToken, undefined, deps)
    if ('reset' in page) {
      const recoveryCount = nextRecoveryCount(collection.recoveryCount, path)
      seen.delete(path)
      return { rows: [], state: { ...state, active: { ...active, collection: { kind, index: 0, recoveryCount } } } }
    }
    checkProgress(seen, path, collection.pageToken, page.nextPageToken)
    if (resource !== 'participant-sessions') {
      const next: MeetState = page.nextPageToken
        ? { ...state, active: { ...active, collection: { kind, index: 0, pageToken: page.nextPageToken, recoveryCount: collection.recoveryCount } } }
        : finishParent(state, active.name, state.cycle.to)
      return { rows: rawRows(page.items.map((item) => ({ ...item, conference_name: active.name })), (item) => JSON.stringify([deps.config.sourceId, item.name])), state: next }
    }
    return { rows: [], state: { ...state, active: { ...active, collection: { ...collection, items: page.items.map(({ name }) => ({ name })), nextPageToken: page.nextPageToken } } } }
  }
  const participant = collection.items[collection.index]
  if (!participant) {
    return { rows: [], state: collection.nextPageToken
      ? { ...state, active: { ...active, collection: { kind, index: 0, pageToken: collection.nextPageToken, recoveryCount: collection.recoveryCount } } }
      : finishParent(state, active.name, state.cycle.to) }
  }
  const path = `${participant.name}/participantSessions`
  const page = await readPage(context, path, 'participantSessions', collection.sessionPageToken, undefined, deps)
  if ('reset' in page) {
    const sessionRecoveryCount = nextRecoveryCount(collection.sessionRecoveryCount, path)
    seen.delete(path)
    return { rows: [], state: { ...state, active: { ...active, collection: { ...collection, sessionPageToken: undefined, sessionRecoveryCount } } } }
  }
  checkProgress(seen, path, collection.sessionPageToken, page.nextPageToken)
  return {
    rows: rawRows(page.items.map((item) => ({ ...item, conference_name: active.name, participant_name: participant.name })), (item) => JSON.stringify([deps.config.sourceId, item.name])),
    state: { ...state, active: { ...active, collection: page.nextPageToken
      ? { ...collection, sessionPageToken: page.nextPageToken }
      : { ...collection, sessionPageToken: undefined, sessionRecoveryCount: undefined, index: collection.index + 1 } } },
  }
}

function parseCollection(raw: unknown, conference: string, resource: Resource | undefined): CollectionProgress {
  if (!isObject(raw) || (raw.kind !== 'participants' && raw.kind !== 'recordings')) throw new IngestConfigError('Meet child collection is invalid.')
  const kind = raw.kind
  if (resource !== undefined && (kind === 'recordings' ? resource !== 'recordings' : resource !== 'participants' && resource !== 'participant-sessions')) throw new IngestConfigError('Meet child collection belongs to another resource stream.')
  if (raw.items !== undefined && (!Array.isArray(raw.items) || resource !== 'participant-sessions' && resource !== undefined || kind !== 'participants')) throw new IngestConfigError('Meet active participant page is invalid.')
  const items = raw.items?.map((item: unknown) => named(item))
  const path = `${conference}/${kind}/`
  if (items && (items.length > 100 || items.some((item) => !item.name.startsWith(path) || item.name.slice(path.length).includes('/')))) throw new IngestConfigError('Meet active participant page is oversized or belongs to another conference.')
  const index = position(raw.index, items?.length ?? 0, 'collection index')
  const sessionPageToken = optionalString(raw.sessionPageToken, 'sessionPageToken')
  const sessionRecoveryCount = parseRecoveryCount(raw.sessionRecoveryCount)
  if ((sessionPageToken !== undefined || sessionRecoveryCount !== undefined) && !items?.[index]) throw new IngestConfigError('Meet session progress has no active participant.')
  return { kind, items, index, pageToken: optionalString(raw.pageToken, 'collection pageToken'), nextPageToken: optionalString(raw.nextPageToken, 'collection nextPageToken'), recoveryCount: parseRecoveryCount(raw.recoveryCount), sessionPageToken, sessionRecoveryCount }
}

function mergeParents(previous: PendingConference[], conferences: Named[], maxPendingConferences: number): PendingConference[] {
  const parents = new Map(previous.map((parent) => [parent.name, parent]))
  for (const conference of conferences) {
    parents.set(conference.name, { ...parents.get(conference.name), name: conference.name, expireTime: optionalTimestamp(conference.expireTime, 'expireTime') })
  }
  if (parents.size > maxPendingConferences) throw new IngestConfigError('Meet pending conference limit exceeded. Restrict the source or deliberately raise maxPendingConferences.')
  return [...parents.values()]
}

function finishParent(state: MeetState, name: string, checkedAt: string): MeetState {
  if (!state.cycle) throw new IngestConfigError('Meet parent completion has no cycle.')
  return { ...state, active: undefined, pending: state.pending.map((parent) => parent.name === name ? { ...parent, checkedAt } : parent), cycle: { ...state.cycle, parentIndex: state.cycle.parentIndex + 1 } }
}

function checkpoint(state: MeetState): MeetChunk {
  return { rows: [], state, id: 'meet-progress' }
}

function checkProgress(seen: Map<string, Set<string>>, path: string, current: string | undefined, next: string | undefined): void {
  if (!next) return
  const tokens = seen.get(path) ?? new Set<string>()
  if (next === current || tokens.has(next)) throw new IngestConfigError(`Meet repeated ${path} page token.`)
  tokens.add(next)
  seen.set(path, tokens)
}

function nextRecoveryCount(previous: number | undefined, path: string): number {
  if ((previous ?? 0) >= 1) throw new IngestConfigError(`Meet unfinished ${path} collection repeatedly rejected a token across resumed runs. Adjust the editable stream chunk budget, run duration, or polling frequency, then explicitly migrate the saved state or use a new stream identity after reviewing coverage.`)
  return (previous ?? 0) + 1
}

function position(value: unknown, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new IngestConfigError(`Meet ${field} is invalid.`)
  return value
}

function parseRecoveryCount(value: unknown): number | undefined {
  if (value !== undefined && value !== 0 && value !== 1) throw new IngestConfigError('Meet checkpoint recovery count must be zero or one.')
  return value
}

function meetScope(config: GoogleMeetReaderConfig): string {
  return JSON.stringify([config.sourceId, config.lookbackDays, config.overlapDays, config.windowDays])
}
