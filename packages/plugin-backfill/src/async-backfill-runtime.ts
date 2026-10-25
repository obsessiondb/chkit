import {
  allReplicas,
  observableSystemTable,
  resolveReplicaFanout,
  type ClickHouseExecutor,
  type ObservableSystemTable,
  type QueryStatus,
} from '@chkit/clickhouse'
import * as Effect from 'effect/Effect'
import * as Schedule from 'effect/Schedule'
import * as Semaphore from 'effect/Semaphore'
import { fromPromise } from './effect-runtime.js'

import type { BackfillChunkState, BackfillOptions, BackfillProgress, BackfillResult } from './async-backfill.js'

export function executeBackfillEffect(options: BackfillOptions): Effect.Effect<BackfillResult, unknown> {
  return Effect.gen(function* () {
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

    if (!((Number.isSafeInteger(concurrency) && concurrency >= 1) || concurrency === Number.POSITIVE_INFINITY)) {
      return yield* Effect.fail(
        new TypeError(
          `Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`,
        ),
      )
    }
    const publication = yield* Semaphore.make(1)
    let observing = true
    const abandon = Effect.sync(() => {
      observing = false
    })

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
      progress = yield* syncProgressEffect(executor, planId, chunks, progress, { cluster })
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
      yield* fromPromise(() => onProgress?.(progress))
    }

    const setChunk = (id: string, next: BackfillChunkState): Effect.Effect<void, unknown> =>
      publication.withPermit(
        Effect.gen(function* () {
          if (!observing) return yield* Effect.interrupt
          progress = updateChunk(progress, id, next)
          yield* fromPromise(() => onProgress?.(progress))
        }).pipe(Effect.onError(() => abandon)),
      )

    const inFlight = (id: string): boolean => {
      const state = getChunk(progress, id)
      return Boolean(state.queryId) && (state.status === 'submitted' || state.status === 'running')
    }
    const scheduledChunks = [
      ...chunks.filter((chunk) => inFlight(chunk.id)),
      ...chunks.filter((chunk) => !inFlight(chunk.id)),
    ]

    yield* Effect.forEach(
      scheduledChunks,
      (chunk) =>
        Effect.gen(function* () {
          if (!observing) return yield* Effect.interrupt
          const state = getChunk(progress, chunk.id)

          // Already terminal from a previous run
          if (state.status === 'done' || state.status === 'failed') return

          // Resumed in-flight: poll to completion
          if (state.status === 'submitted' || state.status === 'running') {
            if (!state.queryId) {
              yield* setChunk(chunk.id, { ...state, status: 'pending' })
            } else {
              yield* pollChunk(executor, state, pollIntervalMs, maxPollErrors, (s) => setChunk(chunk.id, s))
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
          const sql = yield* Effect.try({ try: () => buildQuery(chunk), catch: (error) => error })
          if (!observing) return yield* Effect.interrupt
          yield* fromPromise(() => executor.submit(sql, queryId))
          const submitted: BackfillChunkState = {
            ...getChunk(progress, chunk.id),
            status: 'submitted',
            queryId,
          }
          yield* setChunk(chunk.id, submitted)

          yield* pollChunk(executor, submitted, pollIntervalMs, maxPollErrors, (s) => setChunk(chunk.id, s))
        }).pipe(Effect.onError(() => abandon)),
      { concurrency: Math.min(concurrency, Math.max(1, chunks.length)), discard: true },
    ).pipe(Effect.ensuring(abandon))

    const completed = chunks.filter((c) => getChunk(progress, c.id).status === 'done').length
    const failed = chunks.filter((c) => getChunk(progress, c.id).status === 'failed').length

    return {
      total: chunks.length,
      completed,
      failed,
      progress,
    }
  })
}

/** Build the deterministic query ID for a chunk. */
function chunkQueryId(planId: string, chunkId: string): string {
  return `backfill-${planId}-${chunkId}`
}

function applyQueryStatus(state: BackfillChunkState, qs: QueryStatus): { state: BackfillChunkState; changed: boolean } {
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

function updateChunk(progress: BackfillProgress, id: string, next: BackfillChunkState): BackfillProgress {
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
export function syncProgressEffect(
  executor: ClickHouseExecutor,
  planId: string,
  chunks: Array<{ id: string }>,
  progress: BackfillProgress,
  options?: { cluster?: string },
): Effect.Effect<BackfillProgress, unknown> {
  return Effect.gen(function* () {
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

    const { runningRows, logRows } = yield* readChunkQueries(executor, planId, safePrefix, options?.cluster)
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
  })
}

interface ChunkLogRow {
  query_id: string
  type: string
  written_rows: string
  written_bytes: string
  query_duration_ms: string
  exception: string
}

function readChunkQueries(
  executor: ClickHouseExecutor,
  planId: string,
  safePrefix: string,
  cluster: string | undefined,
): Effect.Effect<{ runningRows: Array<{ query_id: string }>; logRows: ChunkLogRow[] }, unknown> {
  return Effect.gen(function* () {
    const fanout = yield* fromPromise(() => resolveReplicaFanout(executor, cluster))
    const from = (table: ObservableSystemTable) =>
      fanout ? allReplicas(fanout, `system.${table}`) : observableSystemTable(executor, table)
    return yield* Effect.gen(function* () {
      const runningRows = yield* fromPromise(() =>
        executor.query<{ query_id: string }>(
          `SELECT query_id FROM ${from('processes')} WHERE user = currentUser() AND query_id LIKE '${safePrefix}%' SETTINGS skip_unavailable_shards = 0`,
        ),
      )
      const logRows = yield* fromPromise(() =>
        executor.query<ChunkLogRow>(
          `SELECT query_id, type, written_rows, written_bytes, query_duration_ms, exception
FROM ${from('query_log')}
WHERE user = currentUser()
  AND query_id LIKE '${safePrefix}%'
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND is_initial_query = 1
ORDER BY event_time DESC
SETTINGS skip_unavailable_shards = 0`,
        ),
      )
      return { runningRows, logRows }
    }).pipe(
      Effect.mapError(
        (error) =>
          new Error(
            `Backfill plan ${planId}: could not check which chunks are still running on the server (${error instanceof Error ? error.message : String(error)}). Nothing was submitted — re-run the resume.`,
            { cause: error },
          ),
      ),
    )
  })
}

function pollChunk(
  executor: ClickHouseExecutor,
  initial: BackfillChunkState,
  pollIntervalMs: number,
  maxPollErrors: number,
  onChanged: (state: BackfillChunkState) => Effect.Effect<void, unknown>,
): Effect.Effect<BackfillChunkState, unknown> {
  return Effect.gen(function* () {
    let state = initial
    const delay =
      pollIntervalMs > 2_147_483_647 || !Number.isFinite(pollIntervalMs) ? 1 : Math.max(1, Math.trunc(pollIntervalMs))
    while (state.status === 'submitted' || state.status === 'running') {
      yield* Effect.sleep(delay)
      const queryId = state.queryId
      if (!queryId) break
      let consecutiveErrors = 0
      const result = yield* fromPromise(() =>
        executor.queryStatus(queryId, {
          afterTime: state.submittedAt,
        }),
      ).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            consecutiveErrors++
          }),
        ),
        Effect.retry({ while: () => !(consecutiveErrors >= maxPollErrors), schedule: Schedule.spaced(delay) }),
        Effect.map((status) => applyQueryStatus(state, status)),
        Effect.catch(() =>
          Effect.succeed({
            state: {
              ...state,
              status: 'failed' as const,
              finishedAt: new Date().toISOString(),
              error: `Lost contact with query after ${consecutiveErrors} consecutive poll errors`,
            },
            changed: true,
          }),
        ),
      )
      if (result.changed) {
        state = result.state
        yield* onChanged(state)
      }
    }
    return state
  })
}
