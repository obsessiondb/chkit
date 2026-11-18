import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  allReplicas,
  observableSystemTable,
  probeReplicaAccess,
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
  /** Max consecutive poll errors before the chunk's outcome is recorded
   *  unknown and the run stops. Default: 10 */
  maxPollErrors?: number
  /** Called whenever progress changes. Use this to persist state. */
  onProgress?: (progress: BackfillProgress) => void | Promise<void>
  /** Previously saved progress to resume from. */
  resumeFrom?: BackfillProgress
  /** When true, replay chunks whose last attempt the server shows failed. */
  replayFailed?: boolean
  /** When true, replay chunks whose last attempt has an unknown outcome under
   *  a new query id instead of stopping the resume. It can write their rows twice. */
  acceptUnknown?: boolean
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
  return applyEvidence(planId, chunkIds, progress, evidence, { final: false, verifyFailed: false }).progress
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
 * Returns the chunks whose attempt may have run and still has no outcome.
 */
async function reconcileProgress(
  executor: ClickHouseExecutor,
  planId: string,
  chunks: Array<{ id: string }>,
  progress: BackfillProgress,
  options: { cluster?: string; attempts: number; intervalMs: number; verifyFailed: boolean },
): Promise<{ progress: BackfillProgress; unknown: UnknownAttempt[] }> {
  let chunkIds = chunksToSync(chunks, progress)
  if (chunkIds.length === 0) return { progress, unknown: [] }
  let evidence = await readChunkQueries(executor, planId, { prefix: `backfill-${planId}-` }, options.cluster)
  let current = progress
  for (let round = 0; ; round++) {
    const final = round >= options.attempts
    const pass = applyEvidence(planId, chunkIds, current, evidence, { final, verifyFailed: options.verifyFailed })
    current = pass.progress
    if (pass.waiting.length === 0) return { progress: current, unknown: pass.unknown }
    chunkIds = pass.waiting
    await sleep(options.intervalMs)
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
 * finding no row of it is no proof that it never ran:
 * - submitted or running;
 * - pending with a recorded query id, which is saved before every submit;
 * - pending with an older release's replay bound;
 * - failed, when the resume is about to replay it (`verifyFailed`): a
 *   checkpoint can record a failure the server never showed, such as a lost
 *   contact while polling.
 * A pending chunk without either was never submitted by this release.
 */
function attemptMayHaveRun(state: BackfillChunkState, verifyFailed: boolean): boolean {
  if (state.status === 'submitted' || state.status === 'running') return true
  if (state.status === 'pending') return state.queryId !== undefined || state.submittedAt !== undefined
  return state.status === 'failed' && verifyFailed
}

type AttemptOutcome =
  | { kind: 'running' }
  | { kind: 'done'; row: ChunkLogRow }
  | { kind: 'failed'; row: ChunkLogRow }
  | { kind: 'unchanged' }
  | { kind: 'wait' }
  | { kind: 'unknown'; reason: string }

const FAILURE_TYPES = new Set(['ExceptionBeforeStart', 'ExceptionWhileProcessing'])

/**
 * Classify the attempt from every row of its id, not the latest one: a short
 * query's QueryStart and QueryFinish can share an event_time second.
 *
 * - Running on a replica, or any QueryFinish of the id: running, or done.
 *   A QueryFinish means a whole attempt of the chunk committed.
 * - A failure row of the attempt's own id: failed. Only that is proof that
 *   the attempt failed, and so that replaying the chunk cannot write its
 *   rows twice. An older release's replay shares the id with the earlier
 *   attempt, so its failure rows prove nothing.
 * - Otherwise an attempt that may have run (see `attemptMayHaveRun`) waits
 *   through the flush window, then its outcome is unknown. An empty
 *   query_log is no proof that it never ran: logs can flush late, or not at
 *   all, and a denied replica probe reads one replica only.
 * - Anything else stays as it is.
 */
function classifyAttempt(
  planId: string,
  chunkId: string,
  state: BackfillChunkState,
  evidence: ChunkEvidence,
  options: { final: boolean; verifyFailed: boolean },
): AttemptOutcome {
  const queryId = attemptQueryId(planId, chunkId, state)
  if (evidence.running.has(queryId)) return { kind: 'running' }
  const own = evidence.logRows.filter((row) => row.query_id === queryId)
  const finish = own.find((row) => row.type === 'QueryFinish')
  if (finish) return { kind: 'done', row: finish }
  const kind = attemptKind(planId, chunkId, state)
  const failure = own.find((row) => FAILURE_TYPES.has(row.type))
  if (failure && kind !== 'legacy') return { kind: 'failed', row: failure }
  if (!attemptMayHaveRun(state, options.verifyFailed)) return { kind: 'unchanged' }
  if (!options.final) return { kind: 'wait' }
  if (failure) {
    return { kind: 'unknown', reason: 'an older release ran it under the chunk\'s shared query id, so the failure in system.query_log may be an earlier attempt\'s' }
  }
  if (evidence.denied !== undefined) {
    return { kind: 'unknown', reason: `the user may not read every replica (${evidence.denied}), and the replica it can read neither runs it nor has an outcome for it` }
  }
  return { kind: 'unknown', reason: 'it is not running on any replica and system.query_log has no outcome for it' }
}

function applyEvidence(
  planId: string,
  chunkIds: string[],
  progress: BackfillProgress,
  evidence: ChunkEvidence,
  options: { final: boolean; verifyFailed: boolean },
): { progress: BackfillProgress; waiting: string[]; unknown: UnknownAttempt[] } {
  let updated = progress
  const waiting: string[] = []
  const unknown: UnknownAttempt[] = []
  for (const chunkId of chunkIds) {
    const current = getChunk(updated, chunkId)
    const queryId = attemptQueryId(planId, chunkId, current)
    const outcome = classifyAttempt(planId, chunkId, current, evidence, options)
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

interface ChunkLogRow {
  query_id: string
  type: string
  written_rows: number | string
  written_bytes: number | string
  query_duration_ms: number | string
  exception: string
}

interface ChunkEvidence {
  running: Set<string>
  logRows: ChunkLogRow[]
  /** Set when the replica probe was denied: the reads saw one replica only. */
  denied?: string
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

/** readEvidence for the resume's sync: a failed read stops the resume. */
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
 * since replicas' clocks can differ (#765).
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
  const from = (table: ObservableSystemTable) =>
    access.kind === 'fanout' ? allReplicas(access.fanout, `system.${table}`) : observableSystemTable(executor, table)
  const runningRows = await executor.query<{ query_id: string }>(
    `SELECT query_id FROM ${from('processes')} WHERE user = currentUser() AND ${match} SETTINGS skip_unavailable_shards = 0`
  )
  const logRows = await executor.query<ChunkLogRow>(
    `SELECT query_id, type, written_rows, written_bytes, query_duration_ms, exception
FROM ${from('query_log')}
WHERE user = currentUser()
  AND ${match}
  AND type IN ('QueryStart', 'QueryFinish', 'ExceptionBeforeStart', 'ExceptionWhileProcessing')
  AND is_initial_query = 1${pruning}
ORDER BY event_time DESC
SETTINGS skip_unavailable_shards = 0`
  )
  return {
    running: new Set(runningRows.map((row) => row.query_id)),
    logRows,
    ...(access.kind === 'denied' ? { denied: access.error } : {}),
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

/**
 * Follow a submitted attempt to its outcome. Running is read from
 * system.processes (as queryStatus does, with its metrics); once the attempt
 * is not running, the outcome is classified as the resume's sync does it, on
 * every replica, so a shared-id failure is never taken for the attempt's
 * own. After `maxPollErrors` consecutive poll errors, or once polls have
 * found the attempt neither running nor with an outcome for `emptyWindowMs`
 * (the query_log flush gap every finished attempt goes through), the
 * outcome is unknown: the last read has no time bound, the chunk keeps its
 * state, and the run stops once the other chunks end.
 */
async function pollChunk(
  executor: ClickHouseExecutor,
  target: { planId: string; chunkId: string; cluster?: string },
  initial: BackfillChunkState,
  limits: { pollIntervalMs: number; maxPollErrors: number; emptyWindowMs: number },
  onChanged: (state: BackfillChunkState) => void | Promise<void>,
): Promise<UnknownAttempt | undefined> {
  const { planId, chunkId, cluster } = target
  let state = initial
  let errors = 0
  let emptySince: number | undefined
  while (state.status === 'submitted' || state.status === 'running') {
    await sleep(limits.pollIntervalMs)
    const queryId = state.queryId
    if (!queryId) break
    const final = emptySince !== undefined && Date.now() - emptySince >= limits.emptyWindowMs
    let outcome: AttemptOutcome | { kind: 'metrics'; status: QueryStatus }
    try {
      const qs = await executor.queryStatus(queryId, { runningOnly: true })
      outcome = qs.status === 'running'
        ? { kind: 'metrics', status: qs }
        : classifyAttempt(
          planId,
          chunkId,
          state,
          await readEvidence(executor, { ids: [queryId], after: final ? undefined : state.submittedAt }, cluster),
          { final, verifyFailed: false },
        )
    } catch (error) {
      errors++
      if (errors >= limits.maxPollErrors) {
        return { chunkId, queryId, reason: `lost contact with the server after ${errors} consecutive poll errors (${errorMessage(error)})` }
      }
      continue
    }
    errors = 0
    if (outcome.kind === 'metrics' || outcome.kind === 'running') {
      emptySince = undefined
      const result = outcome.kind === 'metrics'
        ? applyQueryStatus(state, outcome.status)
        : { state: { ...state, status: 'running' as const }, changed: state.status !== 'running' }
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
    replayFailed,
    acceptUnknown,
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
  // persisted (e.g. client crash between submit() and state file write), and
  // confirms the failure of each chunk --replay-failed is about to replay.
  let unknown: UnknownAttempt[] = []
  if (resumeFrom) {
    const reconciled = await reconcileProgress(executor, planId, chunks, progress, {
      cluster,
      attempts: outcomeRecheckAttempts,
      intervalMs: outcomeRecheckIntervalMs,
      verifyFailed: replayFailed === true,
    })
    progress = reconciled.progress
    unknown = reconciled.unknown
  }

  // Replay the chunks the server shows failed (with --replay-failed) and,
  // with --accept-unknown, those whose outcome is unknown. Each replay gets a
  // new random query id, recorded here with its query_log bound and persisted
  // below before it is submitted, so polling and a later sync only ever read
  // that attempt's own rows (#765).
  const accepted = new Set(acceptUnknown ? unknown.map((attempt) => attempt.chunkId) : [])
  if (acceptUnknown) unknown = []
  if (unknown.length === 0) {
    const replays = chunks.filter((chunk) => {
      const state = progress[chunk.id]
      if (!state) return false
      return accepted.has(chunk.id) || (replayFailed === true && state.status === 'failed')
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

  // An attempt that may have run and has no outcome may have written its
  // rows: submitting the chunk again could write them twice (#765).
  if (unknown.length > 0) throw unknownOutcomeError(planId, unknown)

  // How long polls wait for a finished attempt's outcome to reach query_log:
  // never shorter than the resume's recheck window, whatever the poll interval.
  const pollLimits = {
    pollIntervalMs,
    maxPollErrors,
    emptyWindowMs: Math.max(outcomeRecheckAttempts * outcomeRecheckIntervalMs, maxPollErrors * pollIntervalMs),
  }

  const setChunk = (id: string, next: BackfillChunkState) => {
    progress = updateChunk(progress, id, next)
    return onProgress?.(progress)
  }

  // A chunk that fails stops new chunks from starting, but the run waits for
  // the chunks in flight, so nothing writes the checkpoint after it returns.
  let stopError: { error: unknown } | undefined
  const pollUnknown: UnknownAttempt[] = []
  await pMap(
    chunks,
    async (chunk) => {
      if (stopError) return
      try {
        const lost = await runChunk(chunk)
        if (lost) pollUnknown.push(lost)
      } catch (error) {
        stopError ??= { error }
      }
    },
    { concurrency },
  )
  if (stopError) throw stopError.error
  if (pollUnknown.length > 0) throw unknownOutcomeError(planId, pollUnknown)

  async function runChunk(chunk: { id: string; from?: string; to?: string }): Promise<UnknownAttempt | undefined> {
    const target = { planId, chunkId: chunk.id, cluster }
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
    // looks unsubmitted. A replay's id and bound were recorded already. A
    // first attempt runs under the chunk's id, without submittedAt.
    const pending = getChunk(progress, chunk.id)
    const queryId = pending.queryId ?? chunkQueryId(planId, chunk.id)
    if (pending.queryId === undefined) await setChunk(chunk.id, { ...pending, queryId })
    const sql = buildQuery(chunk)
    await executor.submit(sql, queryId)
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
