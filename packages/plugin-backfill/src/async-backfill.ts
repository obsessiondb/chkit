import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'
import pMap from 'p-map'

export interface BackfillOptions {
  /** The executor to submit queries to (target ClickHouse) */
  executor: ClickHouseExecutor
  /** Plan ID used as a namespace in deterministic query IDs */
  planId: string
  /** The chunks to process (from buildChunks) */
  chunks: Array<{ id: string; from: string; to: string; [key: string]: unknown }>
  /** Build the SQL for a given chunk. Called once per chunk at submit time. */
  buildQuery: (chunk: { id: string; from: string; to: string }) => string
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Build the deterministic query ID for a chunk. */
function chunkQueryId(planId: string, chunkId: string): string {
  return `backfill-${planId}-${chunkId}`
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
 */
export async function syncProgress(
  executor: ClickHouseExecutor,
  planId: string,
  chunks: Array<{ id: string }>,
  progress: BackfillProgress,
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

  // Escape single-quotes in the prefix for safe SQL embedding
  const safePrefix = prefix.replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_')

  const runningRows = await executor.query<{ query_id: string }>(
    `SELECT query_id FROM clusterAllReplicas('parallel_replicas', system.processes) WHERE query_id LIKE '${safePrefix}%' SETTINGS skip_unavailable_shards = 1`
  )
  const runningSet = new Set(runningRows.map((r) => r.query_id))

  const logRows = await executor.query<{
    query_id: string
    type: string
    written_rows: string
    written_bytes: string
    query_duration_ms: string
    exception: string
  }>(
    `SELECT query_id, type, written_rows, written_bytes, query_duration_ms, exception
FROM clusterAllReplicas('parallel_replicas', system.query_log)
WHERE query_id LIKE '${safePrefix}%'
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND is_initial_query = 1
ORDER BY event_time DESC
SETTINGS skip_unavailable_shards = 1`
  )

  // Deduplicate: take the latest log entry per query_id (results are ordered by event_time DESC)
  const latestLogByQueryId = new Map<string, (typeof logRows)[0]>()
  for (const row of logRows) {
    if (!latestLogByQueryId.has(row.query_id)) {
      latestLogByQueryId.set(row.query_id, row)
    }
  }

  let updated = { ...progress }

  for (const chunkId of chunkIdsToSync) {
    const queryId = chunkQueryId(planId, chunkId)
    const current = updated[chunkId]
    if (!current) continue

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
    progress = await syncProgress(executor, planId, chunks, progress)
  }

  // Reset confirmed-failed chunks to pending AFTER sync so we operate on
  // ground truth. The deterministic query_id is reused; the afterTime filter
  // in queryStatus ensures we ignore stale query_log entries from prior attempts.
  if (replayFailed) {
    // Stamp submittedAt with a 60s buffer so the afterTime filter in
    // queryStatus ignores stale query_log entries from the prior failed
    // attempt while tolerating clock skew between client and server.
    const replayAfterTime = new Date(Date.now() - 60_000).toISOString()
    for (const chunk of chunks) {
      const state = progress[chunk.id]
      if (state?.status === 'failed') {
        progress = updateChunk(progress, chunk.id, { status: 'pending', submittedAt: replayAfterTime })
      }
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

      // Submit and poll
      // submittedAt is intentionally omitted on first submission — it's only
      // used as an afterTime filter to ignore stale query_log entries when
      // replaying a previously failed chunk with the same deterministic query_id.
      // Setting it to local time here would cause clock-skew issues with the
      // ClickHouse server, making the filter exclude valid entries.
      const queryId = chunkQueryId(planId, chunk.id)
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
