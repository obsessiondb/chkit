import { canonicalJson, digest, emptyCheckpoint, type JournalRow } from './journal.js'
import type { CheckpointEnvelope, CommittedCheckpoint } from './types.js'

const EVENT_KINDS = new Set(['run_started', 'work_planned', 'attempt_started', 'retry_scheduled', 'batch_committed', 'work_finished', 'run_finished'])
const WORK_STATES = new Set(['', 'planned', 'running', 'succeeded', 'failed', 'budget_exhausted', 'cancelled'])
const SINK_EVIDENCE = new Set(['', 'clickhouse_ack', 'none_required'])

export interface ValidatedJournalHistory {
  checkpoint: CommittedCheckpoint
  /** All self-contained valid prefixes, including overlapping sibling runs. */
  rows: JournalRow[]
  /** A deterministic evidence fingerprint, not an authority for freshness. */
  headHash: string
  problems: string[]
}

interface RunHeader {
  startedAt: string
  base: CommittedCheckpoint
}

interface PreparedRun {
  runId: string
  rows: JournalRow[]
  unsafeSeq: number
  modern: boolean
  header: RunHeader | undefined
}

interface KnownFact {
  checkpoint: CommittedCheckpoint
  depth: number
  parents: string[]
}

interface Candidate {
  checkpoint: CommittedCheckpoint
  depth: number
  startedAt: string
  runId: string
  ordinal: number
}

/** Project independent run histories from one immutable-part snapshot. */
export function validateJournalHistory(snapshot: readonly JournalRow[], namespaceId: string): ValidatedJournalHistory {
  const problems = new Set<string>()
  const runs = prepareRuns(snapshot, namespaceId, problems)
  const known = new Map<string, KnownFact>()
  const rows: JournalRow[] = []
  const candidates: Candidate[] = []

  // Beta.9 allocated a shared sequence without recording its baseline. Its
  // unambiguous contiguous prefix can be adopted; a fork cannot name a winner.
  const legacy = runs.filter((run) => !run.modern && run.header === undefined)
  const legacyRows = legacyPrefix(legacy, problems)
  if (legacyRows.length > 0) projectRun(legacyRows, emptyCheckpoint(), 0, known, rows, candidates, problems)

  // A header names immutable checkpoint and successful-cycle facts. Resolve
  // parents before children regardless of physical insertion or query order.
  const ready: PreparedRun[] = []
  const missing = new Map<PreparedRun, Set<string>>()
  const waiters = new Map<string, Set<PreparedRun>>()
  for (const run of runs) {
    if (!run.header) continue
    const dependencies = new Set([run.header.base.checkpointId, run.header.base.successId].filter((id) => id !== '' && !known.has(id)))
    missing.set(run, dependencies)
    if (dependencies.size === 0) ready.push(run)
    for (const id of dependencies) {
      const waiting = waiters.get(id) ?? new Set<PreparedRun>()
      waiting.add(run)
      waiters.set(id, waiting)
    }
  }
  for (let index = 0; index < ready.length; index += 1) {
    const run = ready[index]
    const header = run?.header
    if (!run || !header) continue
    missing.delete(run)
    const baseline = resolveBaseline(header.base, known)
    if (baseline === undefined || typeof baseline === 'string') {
      problems.add(`Run "${run.runId}" has an invalid baseline: ${baseline ?? 'missing evidence'}.`)
      continue
    }
    const prefix = run.rows.filter((row) => Number(row.event_seq) < run.unsafeSeq)
    projectRun(prefix, header.base, baseline.depth, known, rows, candidates, problems, header.startedAt, (id) => {
      for (const waiting of waiters.get(id) ?? []) {
        const dependencies = missing.get(waiting)
        dependencies?.delete(id)
        if (dependencies?.size === 0) ready.push(waiting)
      }
      waiters.delete(id)
    })
  }
  for (const run of missing.keys()) problems.add(`Run "${run.runId}" references checkpoint or success evidence missing from this snapshot; replay from a visible valid prefix.`)

  const canonical = rows.sort(compareRows)
  return { checkpoint: selectCheckpoint(candidates), rows: canonical, headHash: extendHeadHash('', canonical), problems: [...problems].sort() }
}

/** Hash canonical logical facts; append time and exact physical retries do not affect it. */
export function extendHeadHash(previousHash: string, rows: readonly JournalRow[]): string {
  const unique = new Map(rows.map((row) => [`${row.run_id}\0${row.event_seq}\0${row.event_id}\0${row.payload_hash}`, row]))
  return [...unique.values()].sort(compareRows).reduce((hash, row) => digest([hash, row.run_id, row.event_id, row.payload_hash]), previousHash)
}

function prepareRuns(snapshot: readonly JournalRow[], namespaceId: string, problems: Set<string>): PreparedRun[] {
  const runs = new Map<string, { facts: Map<number, JournalRow>; unsafeSeq: number; modern: boolean }>()
  for (const row of snapshot) {
    if (row.namespace_id !== namespaceId) {
      problems.add('Snapshot contains facts from a different namespace.')
      continue
    }
    const run = runs.get(row.run_id) ?? { facts: new Map<number, JournalRow>(), unsafeSeq: Infinity, modern: false }
    runs.set(row.run_id, run)
    const found = new Set<string>()
    const seq = integer(row.event_seq, 'event sequence', found)
    if (seq === 0) found.add('event sequences must start at one')
    integer(row.expected_checkpoint_version, 'expected checkpoint version', found)
    integer(row.checkpoint_version, 'checkpoint version', found)
    if (row.run_id === '') found.add('missing run identity')
    if (!Number.isSafeInteger(row.attempt_no) || row.attempt_no < 0) found.add('invalid attempt number')
    if (!EVENT_KINDS.has(row.event_kind)) found.add('invalid event kind')
    if (!WORK_STATES.has(row.work_state)) found.add('invalid work state')
    if (!SINK_EVIDENCE.has(row.sink_evidence)) found.add('invalid sink evidence')
    const modern = validateFactHash(row, found)
    run.modern ||= modern
    const detail = parseObject(row.detail_json, 'invalid detail JSON', found)
    run.modern ||= detail !== undefined && 'journal' in detail
    const previous = run.facts.get(seq)
    if (previous && (previous.event_id !== row.event_id || previous.payload_hash !== row.payload_hash)) found.add('conflicting facts at the same run-local sequence')
    if (found.size > 0) {
      run.unsafeSeq = Math.min(run.unsafeSeq, Number.isSafeInteger(seq) && seq > 0 ? seq : 1)
      report(problems, row.run_id, row.event_seq, found)
    } else if (!previous || row.event_at < previous.event_at) run.facts.set(seq, row)
  }

  return [...runs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([runId, run]): PreparedRun => {
    const rows = [...run.facts.values()].sort((a, b) => Number(a.event_seq) - Number(b.event_seq))
    const first = rows[0]
    let header: RunHeader | undefined
    if (first) {
      const found = new Set<string>()
      const detail = parseObject(first.detail_json, 'invalid detail JSON', found)
      if (detail && 'journal' in detail) {
        header = parseHeader(detail.journal, found)
        if (Number(first.event_seq) !== 1) found.add('run-local sequence gap (missing initial header)')
      } else if (run.modern && !namespaceId.startsWith('@run:')) found.add('missing run checkpoint baseline header')
      if (found.size > 0) {
        report(problems, runId, first.event_seq, found)
        run.unsafeSeq = 1
        header = undefined
        run.modern = true
      }
    }
    return { runId, rows, unsafeSeq: run.unsafeSeq, modern: run.modern && !namespaceId.startsWith('@run:'), header }
  })
}

function legacyPrefix(runs: readonly PreparedRun[], problems: Set<string>): JournalRow[] {
  const facts = new Map<number, JournalRow>()
  let unsafeSeq = Infinity
  for (const run of runs) {
    unsafeSeq = Math.min(unsafeSeq, run.unsafeSeq)
    for (const row of run.rows) {
      const seq = Number(row.event_seq)
      const previous = facts.get(seq)
      if (previous && previous.run_id !== row.run_id) {
        unsafeSeq = Math.min(unsafeSeq, seq)
        problems.add(`Legacy journal sequence ${seq} belongs to conflicting runs; retain its earlier unambiguous prefix and replay uncertain work.`)
      } else facts.set(seq, row)
    }
  }
  const prefix: JournalRow[] = []
  for (const row of [...facts.values()].sort((a, b) => Number(a.event_seq) - Number(b.event_seq))) {
    const seq = Number(row.event_seq)
    if (seq >= unsafeSeq) break
    if (seq !== prefix.length + 1) {
      problems.add(`Legacy journal sequence gap (expected ${prefix.length + 1}, found ${seq}); replay uncertain work.`)
      break
    }
    prefix.push(row)
  }
  return prefix
}

function projectRun(
  facts: readonly JournalRow[], base: CommittedCheckpoint, baseDepth: number,
  known: Map<string, KnownFact>, validRows: JournalRow[], candidates: Candidate[], problems: Set<string>, startedAt?: string,
  publish?: (identity: string) => void
): void {
  const checkpoint = { ...base, headSeq: 0 }
  let depth = baseDepth
  let expectedSeq = 1
  let checkpointJson = base.envelope === undefined ? '' : canonicalJson(base.envelope)
  let latest: Candidate | undefined
  for (const row of facts) {
    const seq = Number(row.event_seq)
    const found = new Set<string>()
    if (seq !== expectedSeq) found.add(`sequence gap (expected ${expectedSeq}, found ${seq})`)
    let envelope = checkpoint.envelope
    if (row.event_kind === 'batch_committed') {
      if (row.sink_evidence !== 'clickhouse_ack' && row.sink_evidence !== 'none_required') found.add('checkpoint commit has no valid sink evidence')
      const expected = Number(row.expected_checkpoint_version)
      const version = Number(row.checkpoint_version)
      envelope = parseEnvelope(row.checkpoint_json, found)
      if (
        expected !== checkpoint.version || version < expected || version > expected + 1 ||
        (version === expected && row.checkpoint_json !== checkpointJson) ||
        (version > expected && row.checkpoint_json === checkpointJson)
      ) found.add('invalid checkpoint transition')
      if (checkpoint.envelope && envelope && (checkpoint.envelope.strategy !== envelope.strategy || checkpoint.envelope.version !== envelope.version)) found.add('checkpoint strategy changed within one lineage')
      if (version > 0 && envelope === undefined) found.add('invalid checkpoint envelope')
    }
    if (found.size > 0) {
      report(problems, row.run_id, row.event_seq, found)
      break
    }
    const parents = [checkpoint.checkpointId, checkpoint.successId].filter((id) => id !== '')
    let identity = ''
    if (row.event_kind === 'batch_committed') {
      if (Number(row.checkpoint_version) > checkpoint.version) {
        identity = `${row.run_id}:${row.event_seq}`
        checkpoint.checkpointId = identity
        depth += 1
      }
      checkpoint.version = Number(row.checkpoint_version)
      checkpoint.envelope = envelope
      checkpointJson = row.checkpoint_json
    }
    if (row.event_kind === 'work_finished' && row.work_state === 'succeeded') {
      identity = `${row.run_id}:${row.event_seq}`
      checkpoint.successId = identity
      checkpoint.lastSuccessSeq = seq
      depth += 1
    }
    checkpoint.headSeq = seq
    expectedSeq = seq + 1
    validRows.push(row)
    if (identity !== '') {
      known.set(identity, { checkpoint: { ...checkpoint }, depth, parents })
      publish?.(identity)
    }
    latest = { checkpoint: { ...checkpoint }, depth, startedAt: startedAt ?? normalizeTimestamp(row.event_at), runId: row.run_id, ordinal: seq }
    // Every advancing timestamp watermark is a completed, receipt-backed
    // interval, even if a later interval in this run rewinds its range.
    if (identity !== '' && timestampWatermark(checkpoint) !== undefined) candidates.push(latest)
  }
  if (latest) candidates.push(latest)
}

function resolveBaseline(base: CommittedCheckpoint, known: ReadonlyMap<string, KnownFact>): KnownFact | string | undefined {
  const checkpoint = base.checkpointId === '' ? undefined : known.get(base.checkpointId)
  const success = base.successId === '' ? undefined : known.get(base.successId)
  if ((base.checkpointId !== '' && !checkpoint) || (base.successId !== '' && !success)) return undefined
  if (base.checkpointId === '' && (base.version !== 0 || base.envelope !== undefined)) return 'initial checkpoint contains an unproven cursor'
  if (checkpoint && (checkpoint.checkpoint.checkpointId !== base.checkpointId || checkpoint.checkpoint.version !== base.version || canonicalJson(checkpoint.checkpoint.envelope) !== canonicalJson(base.envelope))) return 'checkpoint identity does not match its version and envelope'
  if (success && (success.checkpoint.successId !== base.successId || (success.checkpoint.checkpointId !== base.checkpointId && !isAncestor(base.successId, base.checkpointId, known)))) return 'success identity does not belong to this checkpoint lineage'
  return { checkpoint: base, depth: Math.max(checkpoint?.depth ?? 0, success?.depth ?? 0), parents: [base.checkpointId, base.successId].filter((id) => id !== '') }
}

function isAncestor(ancestor: string, descendant: string, known: ReadonlyMap<string, KnownFact>): boolean {
  const pending = [descendant]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === ancestor) return true
    if (id === undefined || visited.has(id)) continue
    visited.add(id)
    pending.push(...(known.get(id)?.parents ?? []))
  }
  return false
}

function selectCheckpoint(candidates: readonly Candidate[]): CommittedCheckpoint {
  if (candidates.length === 0) return emptyCheckpoint()
  const ranked = [...candidates].sort(compareCandidates)
  const leader = ranked[ranked.length - 1]
  if (!leader) return emptyCheckpoint()
  if (timestampWatermark(leader.checkpoint) === undefined) return leader.checkpoint
  const windows = ranked.filter((candidate) => timestampWatermark(candidate.checkpoint) !== undefined && candidate.checkpoint.envelope?.version === leader.checkpoint.envelope?.version)
  windows.sort((a, b) => (timestampWatermark(a.checkpoint) ?? 0) - (timestampWatermark(b.checkpoint) ?? 0) || compareCandidates(a, b))
  return windows[windows.length - 1]?.checkpoint ?? leader.checkpoint
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return a.depth - b.depth || a.checkpoint.version - b.checkpoint.version || a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId) || a.ordinal - b.ordinal
}

function timestampWatermark(checkpoint: CommittedCheckpoint): number | undefined {
  const envelope = checkpoint.envelope
  if (envelope?.strategy !== 'chkit.timestamp_window' || envelope.version !== 1 || typeof envelope.state !== 'object' || envelope.state === null || !('watermark' in envelope.state) || typeof envelope.state.watermark !== 'string') return undefined
  const value = Date.parse(envelope.state.watermark)
  return Number.isNaN(value) ? undefined : value
}

function parseHeader(value: unknown, problems: Set<string>): RunHeader | undefined {
  if (!isObject(value) || value.version !== 2 || typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt)) || !isObject(value.base)) {
    problems.add('invalid run checkpoint baseline header')
    return undefined
  }
  const base = value.base
  if (
    typeof base.version !== 'number' || !Number.isSafeInteger(base.version) || base.version < 0 ||
    typeof base.headSeq !== 'number' || !Number.isSafeInteger(base.headSeq) || base.headSeq < 0 ||
    typeof base.lastSuccessSeq !== 'number' || !Number.isSafeInteger(base.lastSuccessSeq) || base.lastSuccessSeq < 0 ||
    typeof base.checkpointId !== 'string' || typeof base.successId !== 'string'
  ) {
    problems.add('invalid run checkpoint baseline')
    return undefined
  }
  const envelope = base.envelope === undefined ? undefined : parseEnvelope(canonicalJson(base.envelope), problems)
  if (base.version > 0 && envelope === undefined) problems.add('invalid baseline checkpoint envelope')
  if (problems.size > 0) return undefined
  return { startedAt: new Date(value.startedAt).toISOString(), base: { version: base.version, headSeq: base.headSeq, lastSuccessSeq: base.lastSuccessSeq, checkpointId: base.checkpointId, successId: base.successId, envelope } }
}

function validateFactHash(row: JournalRow, problems: Set<string>): boolean {
  const identity = [row.event_seq, row.event_kind, row.work_id, row.batch_id, String(row.attempt_no)]
  const modernId = digest([row.target_id, row.namespace_id, row.run_id, ...identity])
  const legacyId = digest([row.target_id, row.namespace_id, ...identity])
  if (row.event_id !== modernId && row.event_id !== legacyId) problems.add('invalid fact identity')
  const retryAt = normalizedRetryAt(row.retry_at, problems)
  const payload = digest([
    row.event_id, row.expected_checkpoint_version, row.checkpoint_version, row.checkpoint_json,
    row.work_state, row.sink_evidence, row.error_class, row.run_id, retryAt, row.detail_json,
  ])
  if (BigInt(`0x${payload.slice(0, 16)}`).toString() !== row.payload_hash) problems.add('fact with drifting payload')
  return row.event_id === modernId
}

function parseEnvelope(json: string, problems: Set<string>): CheckpointEnvelope | undefined {
  if (json === '') return undefined
  const parsed = parseObject(json, 'invalid checkpoint envelope', problems)
  if (!parsed || typeof parsed.strategy !== 'string' || parsed.strategy === '' || typeof parsed.version !== 'number' || !Number.isSafeInteger(parsed.version) || parsed.version < 1) {
    problems.add('invalid checkpoint envelope')
    return undefined
  }
  const envelope = { strategy: parsed.strategy, version: parsed.version, state: parsed.state }
  if (envelope.strategy === 'chkit.timestamp_window' && envelope.version === 1 && timestampWatermark({ ...emptyCheckpoint(), envelope }) === undefined) {
    problems.add('invalid timestamp watermark')
    return undefined
  }
  return envelope
}

function parseObject(json: string, label: string, problems: Set<string>): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json)
    if (isObject(value)) return value
  } catch {
    // Invalid evidence is diagnosed and its uncertain suffix is replayed.
  }
  problems.add(label)
  return undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: string, label: string, problems: Set<string>): number {
  const parsed = Number(value)
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 0) problems.add(`invalid ${label} (outside the supported safe integer range)`)
  return parsed
}

function normalizedRetryAt(value: string | null, problems: Set<string>): string {
  if (value === null) return ''
  const date = new Date(normalizeTimestamp(value))
  if (Number.isNaN(date.getTime())) {
    problems.add('invalid retry timestamp')
    return ''
  }
  return date.toISOString()
}

function normalizeTimestamp(value: string): string {
  return value.includes(' ') ? `${value.replace(' ', 'T')}Z` : value
}

function compareRows(a: JournalRow, b: JournalRow): number {
  return a.run_id.localeCompare(b.run_id) || Number(a.event_seq) - Number(b.event_seq) || a.event_id.localeCompare(b.event_id) || a.payload_hash.localeCompare(b.payload_hash)
}

function report(problems: Set<string>, runId: string, seq: string, found: ReadonlySet<string>): void {
  for (const problem of found) problems.add(`Run "${runId}" at sequence ${seq}: ${problem}.`)
}
