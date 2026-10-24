import { setTimeout as defaultSleep } from 'node:timers/promises'

import type { ClickHouseExecutor } from './index.js'
import { allReplicas, resolveReplicaFanout } from './replicas.js'

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const PROGRESS_EVERY_MS = 30_000

export interface InsertBarrierOptions {
  /** `clickhouse.cluster`; without it the `default` cluster is probed (ObsessionDB). */
  cluster?: string
  timeoutMs?: number
  pollIntervalMs?: number
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Runs `sql` (a SELECT over `system.processes` that returns a `query_id`
 * column) on every replica once, then again until none of the query ids it
 * returned the first time is still listed.
 *
 * An INSERT builds its pipeline, including the materialized views it feeds,
 * when it starts. After a mirror view is created, the INSERTs that were
 * already running do not write to it. Every one of them is listed in
 * `system.processes` until it ends, so once the ids listed after the view
 * existed on every replica are gone, every INSERT without the mirror has
 * committed. No clock is involved: the first read only has to happen after
 * the view exists, which is why a resumed run can simply read again.
 *
 * On a target with several replicas `system.processes` is read through
 * `clusterAllReplicas`, because an INSERT runs on the replica that received it.
 */
export async function waitForInsertBarrier(
  executor: ClickHouseExecutor,
  sql: string,
  options: InsertBarrierOptions = {},
): Promise<{ waitedFor: number }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})

  const fanout = await resolveReplicaFanout(executor, options.cluster)
  const query = fanout ? sql.replace(/\bsystem\.processes\b/, allReplicas(fanout, 'system.processes')) : sql
  const read = async () =>
    new Set((await executor.query<{ query_id: string }>(stripTrailingSemicolon(query))).map((row) => row.query_id))

  const initial = await read()
  if (initial.size === 0) return { waitedFor: 0 }
  log(`  waiting for ${initial.size} running INSERT ${initial.size === 1 ? 'query' : 'queries'} to finish`)

  const started = now()
  let lastProgress = started
  for (;;) {
    await sleep(pollIntervalMs)
    const current = await read()
    const remaining = [...initial].filter((id) => current.has(id))
    if (remaining.length === 0) return { waitedFor: initial.size }
    const elapsed = now() - started
    if (elapsed >= timeoutMs) {
      throw new Error(
        `${remaining.length} INSERT ${remaining.length === 1 ? 'query' : 'queries'} that started before this step ${remaining.length === 1 ? 'is' : 'are'} still running after ${Math.round(elapsed / 1000)}s (query_id ${remaining.slice(0, 10).join(', ')}${remaining.length > 10 ? ', …' : ''}). ` +
          'Their rows may not be mirrored or snapshotted yet. Let them finish (or KILL QUERY them and retry those inserts after the cutover), then run chkit migrate --apply again: this step reads the running INSERTs anew.',
      )
    }
    if (now() - lastProgress >= PROGRESS_EVERY_MS) {
      lastProgress = now()
      log(`  still waiting for ${remaining.length} INSERT ${remaining.length === 1 ? 'query' : 'queries'} (elapsed ${Math.round(elapsed / 1000)}s)`)
    }
  }
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, '')
}
