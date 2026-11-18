import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  allReplicas,
  observableSystemTable,
  resolveReplicaFanout,
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
 * `resolveReplicaFanout`) both tables are read on every replica, also without
 * `clickhouse.cluster`, and a replica that cannot be read fails the sync
 * instead of being skipped.
 */
export async function syncProgress(
  executor: ClickHouseExecutor,
  planId: string,
  chunks: Array<{ id: string }>,
  progress: BackfillProgress,
  options?: { cluster?: string },
): Promise<BackfillProgress> {
  const prefix = `backfill-${planId}-`

  // Collect query IDs for non-terminal chunks that need reconciliation
  const chunkIdsToSync: string[] = []
  for (const chunk of chunks) {
    const state = progress[chunk.id]
    if (!state || state.status === 'done') continue
    chunkIdsToSync.push(chunk.id)
  }

  if (chunkIdsToSync.length === 0) return progress

  const safePrefix = prefix.replace(/[\\%_']/g, (character) => {
    if (character === "'") return "''"
    if (character === '\\') return '\\\\\\\\'
    return '\\\\' + character
  })

  const { runningRows, logRows } = await readChunkQueries(executor, planId, safePrefix, options?.cluster)
  const runningSet = new Set(runningRows.map((r) => r.query_id))

  // Deduplicate: take the latest log entry per query_id (results are ordered by event_time DESC)
  const latestLogByQueryId = new Map<string, (typeof logRows)[0]>()
  for (const row of logRows) {
    if (!latestLogByQueryId.has(row.query_id)) {
      latestLogByQueryId.set(row.query_id, row)
    }
  }

  let updated = { ...progress }

  for (const chunkId of chunkIdsToSync) {
    const current = updated[chunkId]
    if (!current) continue
    // A replayed attempt runs under the id recorded with it (#765). The
    // deterministic id covers a first attempt whose record was never written.
    const queryId = current.queryId ?? chunkQueryId(planId, chunkId)

    if (runningSet.has(queryId)) {
      updated = updateChunk(updated, chunkId, { ...current, status: 'running', queryId })
    } else {
      const logEntry = latestLogByQueryId.get(queryId)
      if (logEntry) {
        if (logEntry.type === 'QueryFinish') {
          updated = updateChunk(updated, chunkId, {
            ...current,
            status: 'done',
            queryId,
            finishedAt: new Date().toISOString(),
            writtenRows: Number(logEntry.written_rows),
            writtenBytes: Number(logEntry.written_bytes),
            durationMs: Number(logEntry.query_duration_ms),
          })
        } else {
          updated = updateChunk(updated, chunkId, {
            ...current,
            status: 'failed',
            queryId,
            finishedAt: new Date().toISOString(),
            durationMs: Number(logEntry.query_duration_ms),
            error: logEntry.exception,
          })
        }
      }
    }
  }

  return updated
}

interface ChunkLogRow {
  query_id: string
  type: string
  written_rows: number | string
  written_bytes: number | string
  query_duration_ms: number | string
  exception: string
}

async function readChunkQueries(
  executor: ClickHouseExecutor,
  planId: string,
  safePrefix: string,
  cluster: string | undefined,
): Promise<{ runningRows: Array<{ query_id: string }>; logRows: ChunkLogRow[] }> {
  const fanout = await resolveReplicaFanout(executor, cluster)
  const from = (table: ObservableSystemTable) =>
    fanout ? allReplicas(fanout, `system.${table}`) : observableSystemTable(executor, table)
  try {
    const runningRows = await executor.query<{ query_id: string }>(
      `SELECT query_id FROM ${from('processes')} WHERE user = currentUser() AND query_id LIKE '${safePrefix}%' SETTINGS skip_unavailable_shards = 0`
    )
    const logRows = await executor.query<ChunkLogRow>(
      `SELECT query_id, type, written_rows, written_bytes, query_duration_ms, exception
FROM ${from('query_log')}
WHERE user = currentUser()
  AND query_id LIKE '${safePrefix}%'
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND is_initial_query = 1
ORDER BY event_time DESC
SETTINGS skip_unavailable_shards = 0`
    )
    return { runningRows, logRows }
  } catch (error) {
    throw new Error(
      `Backfill plan ${planId}: could not check which chunks are still running on the server (${error instanceof Error ? error.message : String(error)}). Nothing was submitted — re-run the resume.`,
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
  if (resumeFrom) {
    progress = await syncProgress(executor, planId, chunks, progress, { cluster })
  }

  // Reset confirmed-failed chunks to pending AFTER sync so we operate on
  // ground truth. Each replay gets a new random query id, recorded here and
  // persisted below before it is submitted, so polling and a later sync only
  // ever read that attempt's own system.query_log rows (#765). Reusing the
  // failed attempt's id let its ExceptionWhileProcessing row mark the replay
  // failed while it ran.
  //
  // A chunk still pending under a recorded id is a replay that sync did not
  // find: never submitted, or submitted and not yet in query_log (a failed
  // submit stops the run before the chunk's state changes). It gets a new id
  // too, so a failure row that is flushed later is never read as its result.
  for (const chunk of chunks) {
    const state = progress[chunk.id]
    const replay = (replayFailed && state?.status === 'failed') || (state?.status === 'pending' && state.queryId !== undefined)
    if (replay) {
      progress = updateChunk(progress, chunk.id, { status: 'pending', queryId: replayQueryId(planId, chunk.id) })
    }
  }

  // Persist the reconciled state so the caller's checkpoint is up to date
  if (resumeFrom || replayFailed) {
    await onProgress?.(progress)
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
      // was recorded and persisted above, before this submit. submittedAt is
      // never set here: only a replay
      // recorded by an older release carries one, and pollChunk then still
      // passes it as the afterTime filter for that shared deterministic id.
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
