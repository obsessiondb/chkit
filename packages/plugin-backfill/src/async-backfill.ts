import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'
import pMap from 'p-map'

export interface BackfillOptions {
  /** The executor to submit queries to (target ClickHouse) */
  executor: ClickHouseExecutor
  /** The chunks to process (from buildChunks) */
  chunks: Array<{ id: string; from: string; to: string; [key: string]: unknown }>
  /** Build the SQL for a given chunk. Called once per chunk at submit time. */
  buildQuery: (chunk: { id: string; from: string; to: string }) => string
  /** Max concurrent queries running on the server. Default: 3 */
  concurrency?: number
  /** Polling interval in ms. Default: 5000 */
  pollIntervalMs?: number
  /** Called whenever progress changes. Use this to persist state. */
  onProgress?: (progress: BackfillProgress) => void | Promise<void>
  /** Previously saved progress to resume from. */
  resumeFrom?: BackfillProgress
}

export interface BackfillChunkState {
  status: 'pending' | 'submitted' | 'running' | 'done' | 'failed'
  queryId?: string
  submittedAt?: string
  finishedAt?: string
  durationMs?: number
  writtenRows?: number
  writtenBytes?: number
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

function applyQueryStatus(
  state: BackfillChunkState,
  qs: QueryStatus,
): { state: BackfillChunkState; changed: boolean } {
  if (qs.status === 'running') {
    return { state: { ...state, status: 'running' }, changed: state.status !== 'running' }
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

async function pollChunk(
  executor: ClickHouseExecutor,
  initial: BackfillChunkState,
  pollIntervalMs: number,
  onChanged: (state: BackfillChunkState) => void | Promise<void>,
): Promise<BackfillChunkState> {
  let state = initial
  while (state.status === 'submitted' || state.status === 'running') {
    await sleep(pollIntervalMs)
    if (!state.queryId) break
    const qs = await executor.queryStatus(state.queryId)
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
    chunks,
    buildQuery,
    concurrency = 3,
    pollIntervalMs = 5000,
    onProgress,
    resumeFrom,
  } = options

  const initial: BackfillProgress = Object.fromEntries(
    chunks.map((chunk) => {
      const resumed = resumeFrom?.[chunk.id]
      return [chunk.id, resumed ? { ...resumed } : { status: 'pending' as const }]
    }),
  )

  // Shared mutable ref so concurrent pMap workers see each other's updates.
  // Each chunk's *state* is replaced immutably; only the container is shared.
  let progress = initial

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
          await pollChunk(executor, state, pollIntervalMs, (s) => setChunk(chunk.id, s))
          return
        }
      }

      // Submit and poll
      const queryId = `backfill-${chunk.id}`
      const sql = buildQuery(chunk)
      await executor.submit(sql, queryId)
      const submitted: BackfillChunkState = {
        ...getChunk(progress, chunk.id),
        status: 'submitted',
        queryId,
        submittedAt: new Date().toISOString(),
      }
      await setChunk(chunk.id, submitted)

      await pollChunk(executor, submitted, pollIntervalMs, (s) => setChunk(chunk.id, s))
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
