import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { executeBackfillEffect, syncProgressEffect } from './async-backfill-runtime.js'
import { runEffect } from './effect-runtime.js'

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

export function executeBackfill(options: BackfillOptions): Promise<BackfillResult> {
  return runEffect(executeBackfillEffect(options))
}

export function syncProgress(
  executor: ClickHouseExecutor,
  planId: string,
  chunks: Array<{ id: string }>,
  progress: BackfillProgress,
  options?: { cluster?: string },
): Promise<BackfillProgress> {
  return runEffect(syncProgressEffect(executor, planId, chunks, progress, options))
}
