import { definePipeline, defineStream, HttpError, IngestConfigError, rawRows, rawTable, type FetchContext, type ReadContext, type SourceChunk } from '@chkit/plugin-ingest'

const database = 'default'
// Bind this label to one authenticated Google account; use separate stream IDs for another source.
const sourceId = 'google-meet.primary'
const lookbackDays = 30
const overlapDays = 7
const windowDays = 30
const maxPendingConferences = 1_000
const dayMs = 86_400_000
const baseUrl = 'https://meet.googleapis.com/v2'
const scope = JSON.stringify([sourceId, lookbackDays, overlapDays, windowDays])

type Resource = 'conferences' | 'transcripts' | 'transcript-entries'
interface Named { name: string; [key: string]: unknown }
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
}
interface MeetState {
  scope: string
  watermark?: string
  bounds?: { from?: string; to?: string }
  pending: PendingConference[]
  cycle?: Cycle
  active?: ActiveParent
}
interface Page { items: Named[]; nextPageToken?: string }
type MeetContext = ReadContext<{ from: Date | undefined; to: Date | undefined } | undefined, MeetState>
type MeetChunk = SourceChunk<Record<string, unknown>, MeetState>

export const google_meet_conferencesRaw = rawTable({ database, name: 'google_meet_conferences_raw' })
export const google_meet_transcriptsRaw = rawTable({ database, name: 'google_meet_transcripts_raw' })
export const google_meet_transcriptEntriesRaw = rawTable({ database, name: 'google_meet_transcript_entries_raw' })

export const google_meetPipeline = definePipeline({
  id: 'google-meet', tags: ['provider:google-meet'], maxStreams: 1, maxFetches: 1,
  streams: [
    stream('conferences', google_meet_conferencesRaw),
    stream('transcripts', google_meet_transcriptsRaw),
    stream('transcript-entries', google_meet_transcriptEntriesRaw),
  ],
})

function stream(resource: Resource, destination: typeof google_meet_conferencesRaw) {
  return defineStream({
    id: `google-meet.${resource}`, tags: [`resource:${resource}`], destination,
    incremental: {
      id: `google-meet.${resource}.pending`, version: 1, parseState,
      plan: ({ range }) => range,
    },
    batchSize: 1,
    budget: { maxChunks: 200, maxChunkRows: 100 },
    classifyError: (cause) => cause instanceof IngestConfigError ? { kind: 'permanent' } : undefined,
    read: (context) => readResource(context, resource),
  })
}

async function* readResource(context: MeetContext, resource: Resource): AsyncGenerator<MeetChunk> {
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
      const page = await readPage(context, 'conferenceRecords', 'conferenceRecords', cycle.pageToken, filter)
      if ('reset' in page) {
        const recoveryCount = nextRecoveryCount(cycle.recoveryCount, `discovery:${cycle.phase}`)
        seen.delete(`discovery:${cycle.phase}`)
        state = { ...state, cycle: { ...cycle, pageToken: undefined, recoveryCount } }
        yield checkpoint(state)
        continue
      }
      checkProgress(seen, `discovery:${cycle.phase}`, cycle.pageToken, page.nextPageToken)
      const pending = mergeParents(state.pending, page.items)
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
    if (active.transcripts === undefined) {
      const path = `${name}/transcripts`
      const page = await readPage(context, path, 'transcripts', active.transcriptPageToken)
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
    const page = await readPage(context, path, 'transcriptEntries', active.entryPageToken)
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

async function readPage(context: FetchContext, path: string, field: string, pageToken?: string, filter?: string): Promise<Page | { reset: true }> {
  return context.attempt(async (signal) => {
    const token = process.env.GOOGLE_MEET_ACCESS_TOKEN?.trim()
    if (!token) throw new IngestConfigError('Set GOOGLE_MEET_ACCESS_TOKEN.')
    const url = new URL(`${baseUrl}/${path}`)
    url.searchParams.set('pageSize', '100')
    if (filter) url.searchParams.set('filter', filter)
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { Authorization: `Bearer ${token}` }, redirect: 'error' })
    // Replaying the same fixed collection is safe. A second rejection fails visibly.
    if (pageToken && (response.status === 400 || response.status === 410)) return { reset: true }
    if (!response.ok) throw await HttpError.fromResponse(response)
    const payload: unknown = await response.json()
    if (!isObject(payload) || (payload[field] !== undefined && !Array.isArray(payload[field]))) throw new IngestConfigError(`Meet ${field} is not an array.`)
    const values = payload[field] ?? []
    if (!Array.isArray(values)) throw new IngestConfigError(`Meet ${field} is not an array.`)
    if (values.length > 100) throw new IngestConfigError(`Meet ${field} exceeded the requested page size.`)
    const items = values.map((item: unknown) => named(item))
    if (items.some((item) => field === 'conferenceRecords'
      ? !/^conferenceRecords\/[^/]+$/.test(item.name)
      : !item.name.startsWith(`${path}/`) || item.name.slice(path.length + 1).includes('/'))) {
      throw new IngestConfigError(`Meet ${field} returned a resource outside its requested parent.`)
    }
    const nextPageToken = optionalString(payload.nextPageToken, 'nextPageToken')
    return { items, nextPageToken }
  }, { label: `GET ${field}` })
}

function mergeParents(previous: PendingConference[], conferences: Named[]): PendingConference[] {
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

function parseState(raw: unknown): MeetState {
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
    const entryRecoveryCount = parseRecoveryCount(active.entryRecoveryCount)
    if (entryRecoveryCount !== undefined && !transcripts?.[transcriptIndex]) throw new IngestConfigError('Meet entry recovery debt has no active transcript.')
    state.active = { name, transcripts, transcriptIndex, transcriptPageToken: optionalString(active.transcriptPageToken, 'transcriptPageToken'), nextTranscriptPageToken: optionalString(active.nextTranscriptPageToken, 'nextTranscriptPageToken'), entryPageToken: optionalString(active.entryPageToken, 'entryPageToken'), transcriptRecoveryCount: parseRecoveryCount(active.transcriptRecoveryCount), entryRecoveryCount }
  }
  return state
}

function named(value: unknown): Named {
  if (!isObject(value)) throw new IngestConfigError('Meet returned an invalid resource.')
  const name = requiredString(value.name, 'resource name')
  if (!/^conferenceRecords\/[^/?#]+(?:\/transcripts\/[^/?#]+(?:\/entries\/[^/?#]+)?)?$/.test(name)) throw new IngestConfigError('Meet returned an invalid resource name.')
  return { ...value, name }
}

function position(value: unknown, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new IngestConfigError(`Meet ${field} is invalid.`)
  return value
}

function parseRecoveryCount(value: unknown): number | undefined {
  if (value !== undefined && value !== 0 && value !== 1) throw new IngestConfigError('Meet checkpoint recovery count must be zero or one.')
  return value
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, field)
}

function timestamp(value: unknown, field: string): string {
  const result = requiredString(value, field)
  if (!Number.isFinite(Date.parse(result))) throw new IngestConfigError(`Meet ${field} is not a timestamp.`)
  return result
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new IngestConfigError(`Meet ${field} must be a non-empty string.`)
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
