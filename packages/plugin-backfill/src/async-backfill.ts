import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  allReplicas,
  isSendNotAdmitted,
  probeReplicaAccess,
  STRICT_READ_SETTINGS,
  stringLiteral,
  type ClickHouseExecutor,
} from '@chkit/clickhouse'
import pMap from 'p-map'

export interface BackfillOptions {
  /** The executor to submit queries to (target ClickHouse) */
  executor: ClickHouseExecutor
  /** The configured `clickhouse.cluster`. Resume reads chunk status on every replica of
   *  this cluster, or of `default` (a multi-replica ObsessionDB service) when unset. */
  cluster?: string
  /** Plan ID used as a namespace in deterministic query IDs */
  planId: string
  /** The chunks to process (from buildChunks) */
  chunks: Array<{ id: string; from?: string; to?: string; [key: string]: unknown }>
  /** Build the SQL for a given chunk. Called once per chunk at submit time. */
  buildQuery: (chunk: { id: string; from?: string; to?: string }) => string
  /** Max concurrent queries running on the server. Default: 3 */
  concurrency?: number
  /** Polling interval in ms. Default: 5000 */
  pollIntervalMs?: number
  /** Max consecutive poll errors before the chunk's outcome is recorded
   *  unknown and the run stops. Default: 10 */
  maxPollErrors?: number
  /** Called whenever progress changes. Use this to persist state. */
  onProgress?: (progress: BackfillProgress) => void | Promise<void>
  /** Previously saved progress to resume from. */
  resumeFrom?: BackfillProgress
  /** The format `resumeFrom` was saved in: `CHECKPOINT_VERSION` for progress
   *  this release reported. Omit it for progress an older release reported,
   *  which saved a chunk's query id only after its submit: a chunk it lists
   *  as pending without one, or not at all, may have run. */
  checkpointVersion?: number
  /** When true, replay chunks whose last attempt the server shows failed
   *  before it wrote any row. */
  replayFailed?: boolean
  /** When true, replay chunks whose last attempt has an unknown outcome under
   *  a new query id instead of stopping the resume. It can write their rows twice. */
  acceptUnknown?: boolean
  /** How many times a resume reads an outcome again when the first read
   *  cannot settle it (the query_log flush window). Default: 5 */
  outcomeRecheckAttempts?: number
  /** Interval between those reads in ms. Default: 2000 */
  outcomeRecheckIntervalMs?: number
  /** Aborting it stops the run: no read is waited for and no new chunk is
   *  sent, no progress is reported after the last report finishes, and
   *  executeBackfill rejects with a `BackfillInterruptedError`. Chunks already
   *  sent keep running on the server; their progress says they may have run.
   *  Needs an executor with `submitSendsOnce`: another one could send after
   *  the interrupt returned, so executeBackfill refuses it. */
  signal?: AbortSignal
}

export interface BackfillChunkState {
  status: 'pending' | 'submitted' | 'running' | 'done' | 'failed'
  queryId?: string
  submittedAt?: string
  finishedAt?: string
  readRows?: number
  readBytes?: number
  writtenRows?: number
  writtenBytes?: number
  elapsedMs?: number
  durationMs?: number
  error?: string
  /** Set on an attempt this release recorded: it is sent once under its
   *  query id (#765). Older releases could send one id twice (a resume
   *  resubmitted the chunk's id, and chkit-py's driver resent a reset
   *  request), so a failure row of an attempt without it proves nothing. */
  singleSend?: boolean
}

export type BackfillProgress = Record<string, BackfillChunkState>

/**
 * The checkpoint format of this release (#765): every attempt's query id is
 * saved before its submit, so a pending chunk without one was never
 * submitted, and `singleSend` marks an attempt sent once. Older releases
 * saved no version; progress in any other format keeps no `singleSend`.
 */
export const CHECKPOINT_VERSION = 3

// A resume reads an unsettled outcome again 5 times, 2 s apart, which covers
// query_log's default 7.5 s flush interval (as #721 does for migrate). An
// outcome still missing after that is unknown, never taken for "never ran".
const OUTCOME_RECHECK_ATTEMPTS = 5
const OUTCOME_RECHECK_INTERVAL_MS = 2000
const REPLAY_BOUND_MARGIN_MS = 60 * 60 * 1000

export interface BackfillResult {
  total: number
  completed: number
  failed: number
  progress: BackfillProgress
}

/** executeBackfill stopped because its `signal` was aborted. */
export class BackfillInterruptedError extends Error {}

/** Build the deterministic query ID of a chunk's first attempt. */
function chunkQueryId(planId: string, chunkId: string): string {
  return `backfill-${planId}-${chunkId}`
}

/**
 * Build the query ID of a replayed attempt (#765). It is random, so the
 * system.query_log rows under it belong to that attempt alone, and it keeps the
 * plan's prefix, so syncProgress still finds it.
 */
function replayQueryId(planId: string, chunkId: string): string {
  return `${chunkQueryId(planId, chunkId)}-${randomUUID()}`
}

function runningState(state: BackfillChunkState, row: RunningRow): { state: BackfillChunkState; changed: boolean } {
  const next: BackfillChunkState = {
    ...state,
    status: 'running',
    readRows: Number(row.read_rows),
    readBytes: Number(row.read_bytes),
    writtenRows: Number(row.written_rows),
    writtenBytes: Number(row.written_bytes),
    elapsedMs: Math.round(Number(row.elapsed) * 1000),
  }
  const changed =
    state.status !== 'running' ||
    state.readRows !== next.readRows ||
    state.writtenRows !== next.writtenRows ||
    state.elapsedMs !== next.elapsedMs
  return { state: next, changed }
}

function getChunk(progress: BackfillProgress, id: string): BackfillChunkState {
  const state = progress[id]
  if (!state) throw new Error(`No progress entry for chunk ${id}`)
  return state
}

function updateChunk(
  progress: BackfillProgress,
  id: string,
  next: BackfillChunkState,
): BackfillProgress {
  return { ...progress, [id]: next }
}

// The first format that saved each query id before its submit.
const ID_BEFORE_SUBMIT_VERSION = 2

/**
 * Progress in another format, in this release's terms. A `singleSend` from
 * another format proves nothing: a release that ignores it (a rollback to an
 * older one) keeps it and may resend the id. Version 2 already saved each
 * query id before its submit, so its pending chunk without one was never
 * sent. Any other format (an older release's, which saved the id only after
 * the submit returned) may list a chunk as pending, submitted or running
 * without an id, or not at all, after it ran under the chunk's id: it is
 * recorded under that id, which this release reads as "may have run".
 */
function upgradeProgress(
  planId: string,
  chunks: Array<{ id: string }>,
  progress: BackfillProgress,
  version: number | undefined,
): BackfillProgress {
  let upgraded = progress
  for (const chunk of chunks) {
    const saved = progress[chunk.id]
    const { singleSend: _untrusted, ...state } = saved ?? { status: 'pending' as const }
    if (version === ID_BEFORE_SUBMIT_VERSION || state.status === 'done' || state.status === 'failed' || state.queryId !== undefined) {
      if (saved) upgraded = updateChunk(upgraded, chunk.id, state)
      continue
    }
    upgraded = updateChunk(upgraded, chunk.id, { ...state, queryId: chunkQueryId(planId, chunk.id) })
  }
  return upgraded
}

/**
 * Reconcile local progress with server-side state.
 *
 * Queries system.processes and system.query_log for all chunk query IDs
 * to discover queries that were submitted but whose status was never
 * persisted locally (e.g. client crash between submit and state write).
 *
 * A chunk query runs on the replica that received it. So on a multi-replica
 * target both tables are read on every replica, also without
 * `clickhouse.cluster`, and a replica (or the replica probe) that cannot be
 * read fails the sync instead of being skipped (#289).
 *
 * This is one read. An outcome it cannot settle (see `classifyAttempt`)
 * leaves the chunk as it was; executeBackfill reads those chunks again
 * through the query_log flush window before it submits anything.
 */
export async function syncProgress(
  executor: ClickHouseExecutor,
  planId: string,
  chunks: Array<{ id: string }>,
  progress: BackfillProgress,
  options?: { cluster?: string },
): Promise<BackfillProgress> {
  const chunkIds = chunksToSync(chunks, progress)
  if (chunkIds.length === 0) return progress
  const evidence = await readChunkQueries(executor, planId, { prefix: `backfill-${planId}-` }, options?.cluster)
  return applyEvidence(planId, chunkIds, progress, evidence, false).progress
}

function chunksToSync(chunks: Array<{ id: string }>, progress: BackfillProgress): string[] {
  return chunks.filter((chunk) => {
    const state = progress[chunk.id]
    return state !== undefined && state.status !== 'done'
  }).map((chunk) => chunk.id)
}

/** A chunk whose last attempt may have run, and whose outcome the server does not show. */
interface UnknownAttempt {
  chunkId: string
  queryId: string
  reason: string
}

/**
 * The sync before a resume submits anything: one read of every chunk, then
 * reads of the chunks whose outcome is not settled yet, `attempts` times,
 * `intervalMs` apart, which covers the query_log flush interval (#765, as
 * #721 does for async migrate). The last read has no time bound, so a replica
 * clock that differs from the one the bound came from cannot hide a row.
 * Returns the chunks whose attempt may have run and has no settled outcome.
 */
async function reconcileProgress(
  executor: ClickHouseExecutor,
  planId: string,
  chunks: Array<{ id: string }>,
  progress: BackfillProgress,
  options: { cluster?: string; attempts: number; intervalMs: number; signal?: AbortSignal },
): Promise<{ progress: BackfillProgress; unknown: UnknownAttempt[] }> {
  let chunkIds = chunksToSync(chunks, progress)
  if (chunkIds.length === 0) return { progress, unknown: [] }
  let evidence = await readChunkQueries(executor, planId, { prefix: `backfill-${planId}-` }, options.cluster)
  let current = progress
  let unknown: UnknownAttempt[] = []
  for (let round = 0; ; round++) {
    const final = round >= options.attempts
    const pass = applyEvidence(planId, chunkIds, current, evidence, final)
    current = pass.progress
    unknown = [...unknown, ...pass.unknown]
    if (pass.waiting.length === 0) return { progress: current, unknown }
    chunkIds = pass.waiting
    await sleep(options.intervalMs)
    if (options.signal?.aborted) throw interruptedError(planId)
    const states = chunkIds.map((id) => getChunk(current, id))
    const last = round + 1 >= options.attempts
    evidence = await readChunkQueries(
      executor,
      planId,
      {
        ids: chunkIds.map((id, index) => attemptQueryId(planId, id, states[index] as BackfillChunkState)),
        after: last ? undefined : earliestBound(states),
      },
      options.cluster,
    )
  }
}

/** The query id of a chunk's latest attempt. */
function attemptQueryId(planId: string, chunkId: string, state: BackfillChunkState): string {
  return state.queryId ?? chunkQueryId(planId, chunkId)
}

/**
 * How a chunk's latest attempt was recorded:
 * - `replay`: a replay of this release, under a query id of its own (#765).
 *   Its submittedAt is the server time an hour before the replay, a bound
 *   that only prunes query_log by event_date.
 * - `legacy`: a replay recorded by an older release, which reused the
 *   chunk's id and set submittedAt to the client time a minute before the
 *   replay. A failure row of that id may be the earlier attempt's.
 * - `first`: the first attempt, under the chunk's id.
 */
function attemptKind(planId: string, chunkId: string, state: BackfillChunkState): 'replay' | 'legacy' | 'first' {
  const queryId = attemptQueryId(planId, chunkId, state)
  if (queryId !== chunkQueryId(planId, chunkId)) return 'replay'
  return state.submittedAt ? 'legacy' : 'first'
}

/**
 * Whether the chunk's last attempt may have reached the server, so that
 * finding no proof of its outcome leaves it unknown:
 * - submitted or running;
 * - pending with a recorded query id, which is saved before every submit;
 * - pending with an older release's replay bound;
 * - failed: a checkpoint can record a failure the server never showed (an
 *   older release recorded a lost contact while polling as failed), or one
 *   that wrote rows. Whether it is replayed is up to the flags, not this.
 * A pending chunk without either was never submitted.
 */
function attemptMayHaveRun(state: BackfillChunkState): boolean {
  if (state.status === 'submitted' || state.status === 'running' || state.status === 'failed') return true
  return state.status === 'pending' && (state.queryId !== undefined || state.submittedAt !== undefined)
}

type AttemptOutcome =
  | { kind: 'running'; row: RunningRow }
  | { kind: 'done'; row: ChunkLogRow }
  | { kind: 'failed'; row: ChunkLogRow }
  | { kind: 'unchanged' }
  | { kind: 'wait' }
  | { kind: 'unknown'; reason: string }

const FAILURE_TYPES = new Set(['ExceptionBeforeStart', 'ExceptionWhileProcessing'])

/**
 * Classify the attempt from every row of its id, not the latest one: a short
 * query's QueryStart and QueryFinish can share an event_time second. The
 * flags never change the classification; they decide what is replayed.
 *
 * - Running on a replica, or any QueryFinish of the id: running, or done.
 *   A QueryFinish means a whole attempt of the chunk committed.
 * - A failure row of an attempt sent once under its id (`singleSend`), read
 *   on every replica, with no row of the id that wrote a row: failed. Only
 *   that proves a replay cannot write the chunk's rows twice. A failure
 *   after a written row is unknown at once: those rows stay, and a replay
 *   writes them again. An attempt an older release recorded may have been
 *   sent twice under its id, so its failure rows prove nothing, and a read
 *   that may have missed a replica cannot rule out a run or a QueryFinish
 *   on it.
 * - Otherwise an attempt that may have run (see `attemptMayHaveRun`) waits
 *   through the flush window, then its outcome is unknown. An empty
 *   query_log is no proof that it never ran: logs can flush late, or not at
 *   all.
 * - Anything else stays as it is.
 */
function classifyAttempt(
  planId: string,
  chunkId: string,
  state: BackfillChunkState,
  evidence: ChunkEvidence,
  final: boolean,
): AttemptOutcome {
  const queryId = attemptQueryId(planId, chunkId, state)
  const running = evidence.running.get(queryId)
  if (running) return { kind: 'running', row: running }
  const own = evidence.logRows.filter((row) => row.query_id === queryId)
  const finish = own.find((row) => row.type === 'QueryFinish')
  if (finish) return { kind: 'done', row: finish }
  const kind = attemptKind(planId, chunkId, state)
  const failure = own.find((row) => FAILURE_TYPES.has(row.type))
  if (failure && state.singleSend === true && evidence.partial === undefined) {
    // Proof needs every row of the id to state, as a number, that it wrote
    // nothing, and no earlier poll of this attempt to have seen it write.
    const counts = own.map((row) => rowCount(row.written_rows))
    if (counts.some((count) => count === undefined)) {
      return { kind: 'unknown', reason: 'system.query_log does not say how many rows it wrote' }
    }
    const written = Math.max(...(counts as number[]), state.writtenRows ?? 0)
    if (written === 0) return { kind: 'failed', row: failure }
    return { kind: 'unknown', reason: `it failed after writing ${written} rows, which a replay would write again` }
  }
  if (!attemptMayHaveRun(state)) return { kind: 'unchanged' }
  if (!final) return { kind: 'wait' }
  if (failure && kind === 'legacy') {
    return { kind: 'unknown', reason: 'an older release ran it under the chunk\'s shared query id, so the failure in system.query_log may be an earlier attempt\'s' }
  }
  if (evidence.partial !== undefined) {
    return { kind: 'unknown', reason: `${evidence.partial}, and the replica it can read shows neither a run of it nor a QueryFinish` }
  }
  if (failure) {
    return { kind: 'unknown', reason: 'an older release may have sent it more than once under this query id, so the failure in system.query_log may not be its last send' }
  }
  return { kind: 'unknown', reason: 'it is not running on any replica and system.query_log has no outcome for it' }
}

/** A row count as query_log reports it: a whole number, or its digits. */
function rowCount(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}

function applyEvidence(
  planId: string,
  chunkIds: string[],
  progress: BackfillProgress,
  evidence: ChunkEvidence,
  final: boolean,
): { progress: BackfillProgress; waiting: string[]; unknown: UnknownAttempt[] } {
  let updated = progress
  const waiting: string[] = []
  const unknown: UnknownAttempt[] = []
  for (const chunkId of chunkIds) {
    const current = getChunk(updated, chunkId)
    const queryId = attemptQueryId(planId, chunkId, current)
    const outcome = classifyAttempt(planId, chunkId, current, evidence, final)
    if (outcome.kind === 'running') {
      updated = updateChunk(updated, chunkId, { ...current, status: 'running', queryId })
    } else if (outcome.kind === 'done' || outcome.kind === 'failed') {
      updated = updateChunk(updated, chunkId, settledState(current, queryId, outcome))
    } else if (outcome.kind === 'wait') {
      waiting.push(chunkId)
    } else if (outcome.kind === 'unknown') {
      unknown.push({ chunkId, queryId, reason: outcome.reason })
    }
  }
  return { progress: updated, waiting, unknown }
}

function settledState(
  current: BackfillChunkState,
  queryId: string,
  outcome: { kind: 'done' | 'failed'; row: ChunkLogRow },
): BackfillChunkState {
  if (outcome.kind === 'done') {
    return {
      ...current,
      status: 'done',
      queryId,
      finishedAt: new Date().toISOString(),
      writtenRows: Number(outcome.row.written_rows),
      writtenBytes: Number(outcome.row.written_bytes),
      durationMs: Number(outcome.row.query_duration_ms),
    }
  }
  return {
    ...current,
    status: 'failed',
    queryId,
    finishedAt: new Date().toISOString(),
    durationMs: Number(outcome.row.query_duration_ms),
    error: outcome.row.exception,
  }
}

interface RunningRow {
  query_id: string
  read_rows: number | string
  read_bytes: number | string
  written_rows: number | string
  written_bytes: number | string
  elapsed: number | string
}

interface ChunkLogRow {
  query_id: string
  type: string
  written_rows: number | string | null
  written_bytes: number | string
  query_duration_ms: number | string
  exception: string
}

interface ChunkEvidence {
  running: Map<string, RunningRow>
  logRows: ChunkLogRow[]
  /** Why the reads may have missed a replica (see `probeReplicaAccess`). */
  partial?: string
}

function earliestBound(states: BackfillChunkState[]): string | undefined {
  const bounds = states.map((state) => state.submittedAt)
  if (bounds.some((bound) => bound === undefined)) return undefined
  return (bounds as string[]).reduce((earliest, bound) => (Date.parse(bound) < Date.parse(earliest) ? bound : earliest))
}

function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_']/g, (character) => {
    if (character === "'") return "''"
    if (character === '\\') return '\\\\\\\\'
    return `\\\\${character}`
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * readEvidence for the resume's sync: a failed read, including a replica
 * probe that fails for any reason other than a missing cluster or a denied
 * user, stops the resume, whatever the flags: nothing was read.
 */
async function readChunkQueries(
  executor: ClickHouseExecutor,
  planId: string,
  scope: { prefix: string } | { ids: string[]; after?: string },
  cluster: string | undefined,
): Promise<ChunkEvidence> {
  try {
    return await readEvidence(executor, scope, cluster)
  } catch (error) {
    throw new Error(
      `Backfill plan ${planId}: could not check which chunks are still running on the server (${errorMessage(error)}). Nothing was submitted — re-run the resume.`,
      { cause: error },
    )
  }
}

/**
 * Read the chunks' rows in system.processes and system.query_log: by the
 * plan's prefix, or by exact ids, pruned by event_date from `after`. The
 * pruning keeps a day of slack, and no row is filtered by its start time,
 * since replicas' clocks can differ (#765). When the probe cannot show that
 * every replica answers, the reads use the local tables, also with
 * `clickhouse.cluster` set, as chkit-py does, and what they do not find
 * proves nothing.
 */
async function readEvidence(
  executor: ClickHouseExecutor,
  scope: { prefix: string } | { ids: string[]; after?: string },
  cluster: string | undefined,
): Promise<ChunkEvidence> {
  const match = 'prefix' in scope
    ? `query_id LIKE '${likePrefix(scope.prefix)}%'`
    : `query_id IN (${scope.ids.map(stringLiteral).join(', ')})`
  const pruning = 'after' in scope && scope.after
    ? `\n  AND event_date >= toDate32(parseDateTimeBestEffort(${stringLiteral(scope.after)})) - 1`
    : ''
  const access = await probeReplicaAccess(executor, cluster)
  const from = (table: 'processes' | 'query_log') =>
    access.kind === 'fanout' ? allReplicas(access.fanout, `system.${table}`) : `system.${table}`
  const runningRows = await executor.query<RunningRow>(
    `SELECT query_id, read_rows, read_bytes, written_rows, written_bytes, elapsed FROM ${from('processes')} WHERE user = currentUser() AND ${match} SETTINGS ${STRICT_READ_SETTINGS}`
  )
  const logRows = await executor.query<ChunkLogRow>(
    `SELECT query_id, type, written_rows, written_bytes, query_duration_ms, exception
FROM ${from('query_log')}
WHERE user = currentUser()
  AND ${match}
  AND type IN ('QueryStart', 'QueryFinish', 'ExceptionBeforeStart', 'ExceptionWhileProcessing')
  AND is_initial_query = 1${pruning}
ORDER BY event_time DESC
SETTINGS ${STRICT_READ_SETTINGS}`
  )
  return {
    running: new Map(runningRows.map((row) => [row.query_id, row])),
    logRows,
    ...(access.kind === 'partial' ? { partial: access.reason } : {}),
  }
}

/**
 * The bound a replay's query_log reads start from: the server's time an hour
 * before the replay. It only prunes query_log by event_date, with a day of
 * slack; the replay's own query id is what tells its rows apart (#765).
 */
async function readReplayBound(executor: ClickHouseExecutor, planId: string): Promise<string> {
  try {
    const [row] = await executor.query<{ now_ms: number | string }>(
      'SELECT toString(toUnixTimestamp64Milli(now64(3))) AS now_ms',
    )
    const nowMs = Number(row?.now_ms)
    if (!Number.isFinite(nowMs)) throw new Error('the server returned no time')
    return new Date(nowMs - REPLAY_BOUND_MARGIN_MS).toISOString()
  } catch (error) {
    throw new Error(
      `Backfill plan ${planId}: could not read the server time for a replay (${errorMessage(error)}). Nothing was submitted — re-run the resume.`,
      { cause: error },
    )
  }
}

function unknownOutcomeError(planId: string, unknown: UnknownAttempt[]): Error {
  const attempts = unknown.map((attempt) => `chunk ${attempt.chunkId} (query_id ${attempt.queryId}): ${attempt.reason}`)
  return new Error(
    `Backfill plan ${planId}: the outcome of the last attempt is unknown for ${attempts.join('; ')}. A chunk whose outcome is unknown is not submitted again, as it may have written its rows. Re-run the resume once system.query_log records the outcome, or pass --accept-unknown to replay it under a new query id, which can write its rows twice.`,
  )
}

/** `work`, or a rejection with `abortError()` as soon as `signal` aborts. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined, abortError: () => Error): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => undefined)
      reject(abortError())
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function interruptedError(planId: string): BackfillInterruptedError {
  return new BackfillInterruptedError(
    `Backfill plan ${planId}: interrupted. No new chunk was submitted; a chunk already submitted keeps running on the server, and a resume attaches to it.`,
  )
}

/**
 * Follow a submitted attempt to its outcome, on every replica, classified as
 * the resume's sync does it, so a shared-id failure or a partial write is
 * never taken for a failure a replay can follow. After `maxPollErrors`
 * consecutive poll errors, or once polls have found the attempt neither
 * running nor with an outcome for `emptyWindowMs` (the query_log flush gap
 * every finished attempt goes through), the outcome is unknown: the last
 * read has no time bound, the chunk keeps its state, and the run stops once
 * the chunks in flight end.
 */
async function pollChunk(
  executor: ClickHouseExecutor,
  target: { planId: string; chunkId: string; cluster?: string },
  initial: BackfillChunkState,
  limits: { pollIntervalMs: number; maxPollErrors: number; emptyWindowMs: number; stopped: () => boolean },
  onChanged: (state: BackfillChunkState) => void | Promise<void>,
): Promise<UnknownAttempt | undefined> {
  const { planId, chunkId, cluster } = target
  let state = initial
  let errors = 0
  let emptySince: number | undefined
  while ((state.status === 'submitted' || state.status === 'running') && !limits.stopped()) {
    await sleep(limits.pollIntervalMs)
    const queryId = state.queryId
    if (!queryId) break
    const final = emptySince !== undefined && Date.now() - emptySince >= limits.emptyWindowMs
    let outcome: AttemptOutcome
    try {
      const evidence = await readEvidence(executor, { ids: [queryId], after: final ? undefined : state.submittedAt }, cluster)
      outcome = classifyAttempt(planId, chunkId, state, evidence, final)
    } catch (error) {
      errors++
      if (errors >= limits.maxPollErrors) {
        return { chunkId, queryId, reason: `lost contact with the server after ${errors} consecutive poll errors (${errorMessage(error)})` }
      }
      continue
    }
    errors = 0
    if (outcome.kind === 'running') {
      emptySince = undefined
      const result = runningState(state, outcome.row)
      if (result.changed) {
        state = result.state
        await onChanged(state)
      }
    } else if (outcome.kind === 'done' || outcome.kind === 'failed') {
      state = settledState(state, queryId, outcome)
      await onChanged(state)
    } else if (outcome.kind === 'unknown') {
      return { chunkId, queryId, reason: outcome.reason }
    } else {
      emptySince ??= Date.now()
    }
  }
  return undefined
}

export async function executeBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const {
    executor,
    cluster,
    planId,
    chunks,
    buildQuery,
    concurrency = 3,
    pollIntervalMs = 5000,
    maxPollErrors = 10,
    onProgress,
    resumeFrom,
    checkpointVersion,
    replayFailed,
    acceptUnknown,
    outcomeRecheckAttempts = OUTCOME_RECHECK_ATTEMPTS,
    outcomeRecheckIntervalMs = OUTCOME_RECHECK_INTERVAL_MS,
    signal,
  } = options

  if (signal && executor.submitSendsOnce !== true) {
    throw new Error(
      'An interruptible backfill needs an executor with submitSendsOnce, which sends once and asks the run\'s admission as its request is created: another executor could send a chunk after the interrupt returned.',
    )
  }
  const saved = resumeFrom && checkpointVersion !== CHECKPOINT_VERSION
    ? upgradeProgress(planId, chunks, resumeFrom, checkpointVersion)
    : resumeFrom
  let progress: BackfillProgress = Object.fromEntries(
    chunks.map((chunk) => {
      const resumed = saved?.[chunk.id]
      return [chunk.id, resumed ? { ...resumed } : { status: 'pending' as const }]
    }),
  )

  // When resuming, reconcile local state with the server before processing.
  // This catches queries that were submitted but whose status was never
  // persisted (e.g. client crash between submit() and state file write), and
  // checks the failure of every chunk the checkpoint records failed.
  let unknown: UnknownAttempt[] = []
  // A read that hangs (a stalled replica) must not keep an interrupted run,
  // and its lock, waiting: an abort stops waiting for it.
  const interruptible = <T>(work: Promise<T>) => untilAborted(work, signal, () => interruptedError(planId))
  if (resumeFrom) {
    const reconciled = await interruptible(reconcileProgress(executor, planId, chunks, progress, {
      cluster,
      attempts: outcomeRecheckAttempts,
      intervalMs: outcomeRecheckIntervalMs,
      signal,
    }))
    progress = reconciled.progress
    unknown = reconciled.unknown
  }
  if (signal?.aborted) throw interruptedError(planId)

  // Replay the chunks the server shows failed before they wrote a row (with
  // --replay-failed) and, with --accept-unknown, those whose outcome is
  // unknown. A replay gets a new random query id only when its chunk is
  // about to be sent, recorded with its query_log bound before the send, so
  // polling and a later sync only ever read that attempt's own rows (#765),
  // and a chunk the run never reaches keeps its proven state.
  const accepted = new Set(acceptUnknown ? unknown.map((attempt) => attempt.chunkId) : [])
  if (acceptUnknown) unknown = []
  const replays = new Set(chunks.filter((chunk) => {
    const state = progress[chunk.id]
    return state !== undefined && (accepted.has(chunk.id) || (replayFailed === true && state.status === 'failed'))
  }).map((chunk) => chunk.id))
  const replayBound = unknown.length === 0 && replays.size > 0
    ? await interruptible(readReplayBound(executor, planId))
    : undefined

  // After an abort, nothing is reported once the report in progress ends,
  // so a caller that stops right after never sees a later checkpoint.
  let closed = false
  let lastReport: Promise<void> = Promise.resolve()
  const report = (): Promise<void> => {
    if (closed) return lastReport
    lastReport = Promise.resolve(onProgress?.(progress))
    return lastReport
  }

  // Save the reconciled state, every chunk included, before anything is
  // submitted: a chunk this checkpoint lists as pending without a query id
  // was never submitted.
  await report()

  // An attempt that may have run and has no outcome may have written its
  // rows: submitting the chunk again could write them twice (#765).
  if (unknown.length > 0) throw unknownOutcomeError(planId, unknown)

  const setChunk = (id: string, next: BackfillChunkState) => {
    if (closed) return lastReport
    progress = updateChunk(progress, id, next)
    return report()
  }
  // An admitted chunk's own records, saved even after an interrupt: the
  // interrupt waits for them (see `send`).
  const record = (id: string, next: BackfillChunkState) => {
    progress = updateChunk(progress, id, next)
    lastReport = Promise.resolve(onProgress?.(progress))
    return lastReport
  }
  // Only an executor that sends a request once, and asks the admission as
  // the request is created, records attempts as single-send (#765).
  const sendsOnce = executor.submitSendsOnce === true
  const handoffs = new Set<Promise<void>>()
  // Aborted once no chunk may be sent: a submit still waiting for a
  // connection slot is refused without reaching the HTTP agent.
  const dispatchStopped = new AbortController()

  // How long polls wait for a finished attempt's outcome to reach query_log:
  // never shorter than the resume's recheck window, whatever the poll interval.
  // On the first chunk that fails, or whose outcome is unknown, no new chunk
  // starts; the chunks in flight end first.
  let stopError: { error: unknown } | undefined
  let stopDispatch = false
  const pollLimits = {
    pollIntervalMs,
    maxPollErrors,
    emptyWindowMs: Math.max(outcomeRecheckAttempts * outcomeRecheckIntervalMs, maxPollErrors * pollIntervalMs),
    stopped: () => closed,
  }
  const pollUnknown: UnknownAttempt[] = []
  // Checked again right before each send: a chunk can reach its send after
  // another chunk stopped the dispatch, or the run was interrupted.
  const mayStart = () => !stopDispatch && !closed
  const work = pMap(
    chunks,
    async (chunk) => {
      if (!mayStart()) return
      try {
        const lost = await runChunk(chunk)
        if (lost) {
          pollUnknown.push(lost)
          stopDispatch = true
          dispatchStopped.abort()
        }
      } catch (error) {
        stopError ??= { error }
        stopDispatch = true
        dispatchStopped.abort()
      }
    },
    { concurrency },
  )
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      closed = true
      stopDispatch = true
      dispatchStopped.abort()
      // Admitted chunks hand their request off, or are refused and saved
      // back, before the interrupt returns.
      void Promise.all([...handoffs])
        .then(() => lastReport)
        .then(() => reject(interruptedError(planId)), () => reject(interruptedError(planId)))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    work.then(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, reject)
  })
  // A stop after the last chunk settled may have refused a chunk's send.
  if (signal?.aborted) throw interruptedError(planId)
  if (stopError) throw stopError.error
  if (pollUnknown.length > 0) throw unknownOutcomeError(planId, pollUnknown)

  async function runChunk(chunk: { id: string; from?: string; to?: string }): Promise<UnknownAttempt | undefined> {
    const target = { planId, chunkId: chunk.id, cluster }

    // A replay: its own query id, recorded with the bound right before the send.
    if (replays.has(chunk.id) && replayBound !== undefined) {
      return send(chunk, target, getChunk(progress, chunk.id), {
        status: 'pending',
        queryId: replayQueryId(planId, chunk.id),
        submittedAt: replayBound,
        ...(sendsOnce ? { singleSend: true } : {}),
      })
    }

    const state = getChunk(progress, chunk.id)

    // Already terminal from a previous run
    if (state.status === 'done' || state.status === 'failed') return undefined

    // Resumed in-flight: poll to completion
    if (state.status === 'submitted' || state.status === 'running') {
      if (!state.queryId) {
        await setChunk(chunk.id, { ...state, status: 'pending' })
      } else {
        return pollChunk(executor, target, state, pollLimits, (s) => setChunk(chunk.id, s))
      }
    }

    // Record the attempt's query id before its submit, so a run that stops
    // while the INSERT runs leaves a chunk that may have run, never one that
    // looks unsubmitted. A first attempt runs under the chunk's id, without
    // submittedAt. (A pending chunk with an id here may have run, and the
    // resume's sync settled it, so it is never resent under that id.)
    const pending = getChunk(progress, chunk.id)
    if (pending.queryId !== undefined) return undefined
    return send(chunk, target, pending, {
      ...pending,
      queryId: chunkQueryId(planId, chunk.id),
      ...(sendsOnce ? { singleSend: true } : {}),
    })
  }

  /**
   * Record `attempt` and send the chunk under its query id. The chunk is
   * admitted first: from then until its request is created, or refused and
   * its `previous` state saved back, an interrupt waits for it, so no chunk
   * of a stopped run is sent or saved after the interrupt returns. The SQL is
   * built before anything is recorded.
   */
  async function send(
    chunk: { id: string; from?: string; to?: string },
    target: { planId: string; chunkId: string; cluster?: string },
    previous: BackfillChunkState,
    attempt: BackfillChunkState,
  ): Promise<UnknownAttempt | undefined> {
    const queryId = attempt.queryId as string
    const sql = buildQuery(chunk)
    if (!mayStart()) return undefined
    let handOff: () => void = () => undefined
    const handoff = new Promise<void>((resolve) => { handOff = resolve })
    handoffs.add(handoff)
    const settle = () => {
      handoffs.delete(handoff)
      handOff()
    }
    try {
      await record(chunk.id, attempt)
      if (!mayStart()) {
        await record(chunk.id, previous)
        return undefined
      }
      if (sendsOnce) {
        // The handoff settles once the request's bytes are on its socket (or
        // it ended without getting there): only then can no part of it start
        // after an interrupt returned.
        await executor.submit(sql, queryId, undefined, {
          admit: () => mayStart(),
          handedOff: settle,
          signal: dispatchStopped.signal,
        })
      } else {
        // Nothing proves when another executor's request starts, so its
        // attempt is not single-send and an interrupt does not wait for it.
        settle()
        await executor.submit(sql, queryId)
      }
    } catch (error) {
      if (!isSendNotAdmitted(error)) throw error
      await record(chunk.id, previous)
      return undefined
    } finally {
      settle()
    }
    const submitted: BackfillChunkState = {
      ...getChunk(progress, chunk.id),
      status: 'submitted',
      queryId,
    }
    await setChunk(chunk.id, submitted)

    return pollChunk(executor, target, submitted, pollLimits, (s) => setChunk(chunk.id, s))
  }

  const completed = chunks.filter((c) => getChunk(progress, c.id).status === 'done').length
  const failed = chunks.filter((c) => getChunk(progress, c.id).status === 'failed').length

  return {
    total: chunks.length,
    completed,
    failed,
    progress,
  }
}
