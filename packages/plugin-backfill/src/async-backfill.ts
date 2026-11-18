import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  allReplicas,
  observableSystemTable,
  resolveReplicaFanoutOrThrow,
  stringLiteral,
  type ClickHouseExecutor,
  type ObservableSystemTable,
  type QueryStatus,
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
  /** Max consecutive poll errors before marking a chunk as failed. Default: 10 */
  maxPollErrors?: number
  /** Called whenever progress changes. Use this to persist state. */
  onProgress?: (progress: BackfillProgress) => void | Promise<void>
  /** Previously saved progress to resume from. */
  resumeFrom?: BackfillProgress
  /** When true, reset chunks confirmed failed (both locally and on server) back to pending. */
  replayFailed?: boolean
  /** How many times a resume reads a replay's outcome again when the first
   *  read cannot settle it (the query_log flush window). Default: 5 */
  outcomeRecheckAttempts?: number
  /** Interval between those reads in ms. Default: 2000 */
  outcomeRecheckIntervalMs?: number
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
}

export type BackfillProgress = Record<string, BackfillChunkState>

// A resume reads an unsettled replay outcome again 5 times, 2 s apart, which
// covers query_log's default 7.5 s flush interval (as #721 does for migrate).
const OUTCOME_RECHECK_ATTEMPTS = 5
const OUTCOME_RECHECK_INTERVAL_MS = 2000
const REPLAY_BOUND_MARGIN_MS = 60 * 60 * 1000

export interface BackfillResult {
  total: number
  completed: number
  failed: number
  progress: BackfillProgress
}

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

function applyQueryStatus(
  state: BackfillChunkState,
  qs: QueryStatus,
): { state: BackfillChunkState; changed: boolean } {
  if (qs.status === 'running') {
    const next: BackfillChunkState = {
      ...state,
      status: 'running',
      readRows: qs.readRows,
      readBytes: qs.readBytes,
      writtenRows: qs.writtenRows,
      writtenBytes: qs.writtenBytes,
      elapsedMs: qs.elapsedMs,
    }
    const metricsChanged =
      state.status !== 'running' ||
      state.readRows !== qs.readRows ||
      state.writtenRows !== qs.writtenRows ||
      state.elapsedMs !== qs.elapsedMs
    return { state: next, changed: metricsChanged }
  }
  if (qs.status === 'finished') {
    return {
      state: {
        ...state,
        status: 'done',
        finishedAt: new Date().toISOString(),
        durationMs: qs.durationMs,
        writtenRows: qs.writtenRows,
        writtenBytes: qs.writtenBytes,
      },
      changed: true,
    }
  }
  if (qs.status === 'failed') {
    return {
      state: {
        ...state,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: qs.durationMs,
        error: qs.error,
      },
      changed: true,
    }
  }
  // 'unknown' — leave status as-is (query_log may not have flushed yet)
  return { state, changed: false }
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

/**
 * Reconcile local progress with server-side state.
 *
 * Queries system.processes and system.query_log for all chunk query IDs
 * to discover queries that were submitted but whose status was never
 * persisted locally (e.g. client crash between submit and state write).
 *
 * A chunk query runs on the replica that received it, and a chunk this read
 * does not find is submitted again (#289). So on a multi-replica target (see
 * `resolveReplicaFanoutOrThrow`) both tables are read on every replica, also
 * without `clickhouse.cluster`, and a replica (or the replica probe) that
 * cannot be read fails the sync instead of being skipped.
 *
 * This is one read. An outcome it cannot settle yet (see `classifyAttempt`)
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

/**
 * The sync before a resume submits anything: one read of every chunk, then
 * reads of the chunks whose outcome is not settled yet, `attempts` times,
 * `intervalMs` apart, which covers the query_log flush interval (#765, as
 * #721 does for async migrate). Returns the chunks whose attempt started and
 * still has no outcome after the last read.
 */
async function reconcileProgress(
  executor: ClickHouseExecutor,
  planId: string,
  chunks: Array<{ id: string }>,
  progress: BackfillProgress,
  options: { cluster?: string; attempts: number; intervalMs: number },
): Promise<{ progress: BackfillProgress; unknown: string[] }> {
  let chunkIds = chunksToSync(chunks, progress)
  if (chunkIds.length === 0) return { progress, unknown: [] }
  let evidence = await readChunkQueries(executor, planId, { prefix: `backfill-${planId}-` }, options.cluster)
  let current = progress
  for (let round = 0; ; round++) {
    const final = round >= options.attempts
    const pass = applyEvidence(planId, chunkIds, current, evidence, final)
    current = pass.progress
    if (pass.waiting.length === 0) return { progress: current, unknown: pass.unknown }
    chunkIds = pass.waiting
    await sleep(options.intervalMs)
    const states = chunkIds.map((id) => getChunk(current, id))
    evidence = await readChunkQueries(
      executor,
      planId,
      { ids: chunkIds.map((id, index) => attemptQueryId(planId, id, states[index] as BackfillChunkState)), after: earliestBound(states) },
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
 *   that only prunes query_log.
 * - `legacy`: a replay recorded by an older release, which reused the
 *   chunk's id and set submittedAt to the client time a minute before the
 *   replay. A failure row after that bound may be the earlier attempt's.
 * - `first`: the first attempt, under the chunk's id.
 */
function attemptKind(planId: string, chunkId: string, state: BackfillChunkState): 'replay' | 'legacy' | 'first' {
  const queryId = attemptQueryId(planId, chunkId, state)
  if (queryId !== chunkQueryId(planId, chunkId)) return 'replay'
  return state.submittedAt ? 'legacy' : 'first'
}

type AttemptOutcome =
  | { kind: 'running' }
  | { kind: 'done'; row: ChunkLogRow }
  | { kind: 'failed'; row: ChunkLogRow }
  | { kind: 'unchanged' }
  | { kind: 'wait' }
  | { kind: 'unknown' }

/**
 * Classify the attempt from every row of its id, not the latest one: a short
 * query's QueryStart and QueryFinish can share an event_time second.
 *
 * - Running on a replica, or any QueryFinish: running, or done.
 * - A failure: failed, except that a legacy failure is the attempt's own only
 *   once the flush window has passed without a QueryFinish.
 * - A pending replay (this release's or a legacy one) is pending because its
 *   submit did not return: it may not have run, or it ended and is not in
 *   query_log yet. It waits through the flush window. Then a QueryStart
 *   without an outcome is unknown, and no row at all means it never ran.
 * - Anything else stays as it is, as before #765: a first attempt is
 *   submitted again when nothing is found, and a submitted or running chunk
 *   is polled.
 */
function classifyAttempt(
  planId: string,
  chunkId: string,
  state: BackfillChunkState,
  evidence: ChunkEvidence,
  final: boolean,
): AttemptOutcome {
  const queryId = attemptQueryId(planId, chunkId, state)
  if (evidence.running.has(queryId)) return { kind: 'running' }
  // Any QueryFinish of the id means a whole attempt of the chunk committed, so
  // it counts whenever it started (an older release's bound is the client's
  // clock). The bound only keeps an earlier attempt's QueryStart or failure
  // from being read as this attempt's.
  const own = evidence.logRows.filter((row) => row.query_id === queryId)
  const finish = own.find((row) => row.type === 'QueryFinish')
  if (finish) return { kind: 'done', row: finish }
  const bound = state.submittedAt ? Math.floor(Date.parse(state.submittedAt) / 1000) : undefined
  const rows = own.filter((row) => bound === undefined || row.start_unix === undefined || Number(row.start_unix) >= bound)
  const kind = attemptKind(planId, chunkId, state)
  const failure = rows.find((row) => row.type === 'ExceptionWhileProcessing')
  if (failure) return kind === 'legacy' && !final ? { kind: 'wait' } : { kind: 'failed', row: failure }
  if (state.status !== 'pending' || kind === 'first') return { kind: 'unchanged' }
  if (!final) return { kind: 'wait' }
  return rows.some((row) => row.type === 'QueryStart') ? { kind: 'unknown' } : { kind: 'unchanged' }
}

function applyEvidence(
  planId: string,
  chunkIds: string[],
  progress: BackfillProgress,
  evidence: ChunkEvidence,
  final: boolean,
): { progress: BackfillProgress; waiting: string[]; unknown: string[] } {
  let updated = progress
  const waiting: string[] = []
  const unknown: string[] = []
  for (const chunkId of chunkIds) {
    const current = getChunk(updated, chunkId)
    const queryId = attemptQueryId(planId, chunkId, current)
    const outcome = classifyAttempt(planId, chunkId, current, evidence, final)
    if (outcome.kind === 'running') {
      updated = updateChunk(updated, chunkId, { ...current, status: 'running', queryId })
    } else if (outcome.kind === 'done') {
      updated = updateChunk(updated, chunkId, {
        ...current,
        status: 'done',
        queryId,
        finishedAt: new Date().toISOString(),
        writtenRows: Number(outcome.row.written_rows),
        writtenBytes: Number(outcome.row.written_bytes),
        durationMs: Number(outcome.row.query_duration_ms),
      })
    } else if (outcome.kind === 'failed') {
      updated = updateChunk(updated, chunkId, {
        ...current,
        status: 'failed',
        queryId,
        finishedAt: new Date().toISOString(),
        durationMs: Number(outcome.row.query_duration_ms),
        error: outcome.row.exception,
      })
    } else if (outcome.kind === 'wait') {
      waiting.push(chunkId)
    } else if (outcome.kind === 'unknown') {
      unknown.push(chunkId)
    }
  }
  return { progress: updated, waiting, unknown }
}

interface ChunkLogRow {
  query_id: string
  type: string
  written_rows: number | string
  written_bytes: number | string
  query_duration_ms: number | string
  exception: string
  start_unix?: number | string
}

interface ChunkEvidence {
  running: Set<string>
  logRows: ChunkLogRow[]
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

/**
 * Read the chunks' rows in system.processes and system.query_log: by the
 * plan's prefix, or by exact ids (the rechecks), then pruned by `after`.
 */
async function readChunkQueries(
  executor: ClickHouseExecutor,
  planId: string,
  scope: { prefix: string } | { ids: string[]; after?: string },
  cluster: string | undefined,
): Promise<ChunkEvidence> {
  const match = 'prefix' in scope
    ? `query_id LIKE '${likePrefix(scope.prefix)}%'`
    : `query_id IN (${scope.ids.map(stringLiteral).join(', ')})`
  const pruning = 'after' in scope && scope.after
    ? `\n  AND event_date >= toDate32(parseDateTimeBestEffort(${stringLiteral(scope.after)})) - 1`
    : ''
  try {
    const fanout = await resolveReplicaFanoutOrThrow(executor, cluster)
    const from = (table: ObservableSystemTable) =>
      fanout ? allReplicas(fanout, `system.${table}`) : observableSystemTable(executor, table)
    const runningRows = await executor.query<{ query_id: string }>(
      `SELECT query_id FROM ${from('processes')} WHERE user = currentUser() AND ${match} SETTINGS skip_unavailable_shards = 0`
    )
    const logRows = await executor.query<ChunkLogRow>(
      `SELECT query_id, type, written_rows, written_bytes, query_duration_ms, exception, toUnixTimestamp(query_start_time) AS start_unix
FROM ${from('query_log')}
WHERE user = currentUser()
  AND ${match}
  AND type IN ('QueryStart', 'QueryFinish', 'ExceptionWhileProcessing')
  AND is_initial_query = 1${pruning}
ORDER BY event_time DESC
SETTINGS skip_unavailable_shards = 0`
    )
    return { running: new Set(runningRows.map((row) => row.query_id)), logRows }
  } catch (error) {
    throw new Error(
      `Backfill plan ${planId}: could not check which chunks are still running on the server (${error instanceof Error ? error.message : String(error)}). Nothing was submitted — re-run the resume.`,
      { cause: error },
    )
  }
}

/**
 * The bound a replay's query_log reads start from: the server's time an hour
 * before the replay. It only prunes query_log by event_date, and the hour
 * covers clock skew between replicas; the replay's own query id is what
 * tells its rows apart (#765).
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
      `Backfill plan ${planId}: could not read the server time for a replay (${error instanceof Error ? error.message : String(error)}). Nothing was submitted — re-run the resume.`,
      { cause: error },
    )
  }
}

async function pollChunk(
  executor: ClickHouseExecutor,
  initial: BackfillChunkState,
  pollIntervalMs: number,
  maxPollErrors: number,
  onChanged: (state: BackfillChunkState) => void | Promise<void>,
): Promise<BackfillChunkState> {
  let state = initial
  let consecutiveErrors = 0
  while (state.status === 'submitted' || state.status === 'running') {
    await sleep(pollIntervalMs)
    if (!state.queryId) break
    let qs: QueryStatus
    try {
      qs = await executor.queryStatus(state.queryId, {
        afterTime: state.submittedAt,
      })
    } catch {
      consecutiveErrors++
      if (consecutiveErrors >= maxPollErrors) {
        state = {
          ...state,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: `Lost contact with query after ${consecutiveErrors} consecutive poll errors`,
        }
        await onChanged(state)
        break
      }
      continue
    }
    consecutiveErrors = 0
    const result = applyQueryStatus(state, qs)
    if (result.changed) {
      state = result.state
      await onChanged(state)
    }
  }
  return state
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
    replayFailed,
    outcomeRecheckAttempts = OUTCOME_RECHECK_ATTEMPTS,
    outcomeRecheckIntervalMs = OUTCOME_RECHECK_INTERVAL_MS,
  } = options

  let progress: BackfillProgress = Object.fromEntries(
    chunks.map((chunk) => {
      const resumed = resumeFrom?.[chunk.id]
      return [chunk.id, resumed ? { ...resumed } : { status: 'pending' as const }]
    }),
  )

  // When resuming, reconcile local state with the server before processing.
  // This catches queries that were submitted but whose status was never
  // persisted (e.g. client crash between submit() and state file write).
  let unknown: string[] = []
  if (resumeFrom) {
    const reconciled = await reconcileProgress(executor, planId, chunks, progress, {
      cluster,
      attempts: outcomeRecheckAttempts,
      intervalMs: outcomeRecheckIntervalMs,
    })
    progress = reconciled.progress
    unknown = reconciled.unknown
  }

  // Reset confirmed-failed chunks to pending AFTER sync so we operate on
  // ground truth. Each replay gets a new random query id, recorded here with
  // its query_log bound and persisted below before it is submitted, so
  // polling and a later sync only ever read that attempt's own rows (#765).
  // Reusing the failed attempt's id let its ExceptionWhileProcessing row mark
  // the replay failed while it ran. A replay an older release reset but did
  // not record as submitted gets one too.
  if (unknown.length === 0) {
    const replays = chunks.filter((chunk) => {
      const state = progress[chunk.id]
      if (!state) return false
      if (replayFailed && state.status === 'failed') return true
      return state.status === 'pending' && attemptKind(planId, chunk.id, state) === 'legacy'
    })
    if (replays.length > 0) {
      const submittedAt = await readReplayBound(executor, planId)
      for (const chunk of replays) {
        progress = updateChunk(progress, chunk.id, { status: 'pending', queryId: replayQueryId(planId, chunk.id), submittedAt })
      }
    }
  }

  // Persist the reconciled state so the caller's checkpoint is up to date
  if (resumeFrom || replayFailed) {
    await onProgress?.(progress)
  }

  // A replay that started and has no outcome may have written its rows:
  // submitting the chunk again could write them twice (#765).
  if (unknown.length > 0) {
    const attempts = unknown.map((id) => `chunk ${id} (query_id ${attemptQueryId(planId, id, getChunk(progress, id))})`)
    throw new Error(
      `Backfill plan ${planId}: the last attempt of ${attempts.join(', ')} started, but it is not running on any replica and system.query_log has no outcome for it. Nothing was submitted, so no chunk runs twice. Re-run the resume once system.query_log records the outcome.`,
    )
  }

  const setChunk = (id: string, next: BackfillChunkState) => {
    progress = updateChunk(progress, id, next)
    return onProgress?.(progress)
  }

  await pMap(
    chunks,
    async (chunk) => {
      const state = getChunk(progress, chunk.id)

      // Already terminal from a previous run
      if (state.status === 'done' || state.status === 'failed') return

      // Resumed in-flight: poll to completion
      if (state.status === 'submitted' || state.status === 'running') {
        if (!state.queryId) {
          await setChunk(chunk.id, { ...state, status: 'pending' })
        } else {
          await pollChunk(executor, state, pollIntervalMs, maxPollErrors, (s) => setChunk(chunk.id, s))
          return
        }
      }

      // Submit and poll. A pending chunk with a queryId is a replay whose id
      // and bound were persisted before this submit; a run that stopped before
      // the replay ran submits it under that same id. A first attempt has no
      // submittedAt, as before #765.
      const queryId = getChunk(progress, chunk.id).queryId ?? chunkQueryId(planId, chunk.id)
      const sql = buildQuery(chunk)
      await executor.submit(sql, queryId)
      const submitted: BackfillChunkState = {
        ...getChunk(progress, chunk.id),
        status: 'submitted',
        queryId,
      }
      await setChunk(chunk.id, submitted)

      await pollChunk(executor, submitted, pollIntervalMs, maxPollErrors, (s) => setChunk(chunk.id, s))
    },
    { concurrency },
  )

  const completed = chunks.filter((c) => getChunk(progress, c.id).status === 'done').length
  const failed = chunks.filter((c) => getChunk(progress, c.id).status === 'failed').length

  return {
    total: chunks.length,
    completed,
    failed,
    progress,
  }
}
