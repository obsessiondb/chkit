import { describe, expect, test } from 'bun:test'

import {
  allReplicas,
  resolveReplicaFanout,
  type ClickHouseExecutor,
  type ReplicaFanout,
} from '@chkit/clickhouse'
import { createLiveExecutor, createPrefix, getLiveEnv, pollUntil } from '@chkit/clickhouse/e2e-testkit'

import { executeBackfill, type BackfillChunkState } from './async-backfill.js'

// #289: a chunk query runs on the replica that received it. On a multi-replica
// service (ObsessionDB, without clickhouse.cluster) a resume whose reads land on
// another replica used to miss the running chunk and submit it again. The test
// submits until a chunk runs on a replica other than the one the resuming
// executor reads from; the single-node local stack has only that replica.

// About 10 s, long enough to resume while it runs.
const CHUNK_SQL = 'SELECT sleepEachRow(0.5) FROM numbers(20) SETTINGS max_block_size = 1'
const MAX_SUBMITS = 8

describe('executeBackfill resume on every replica (live)', () => {
  test('a chunk running on another replica resumes as running and is not submitted again', async () => {
    const env = getLiveEnv()
    const observer = createLiveExecutor(env)
    const planId = createPrefix('bf_replicas').slice(0, -1)
    const attempts: Promise<unknown>[] = []
    const submitters: ClickHouseExecutor[] = []
    try {
      const observerHost = await hostOf(observer)
      const fanout = await resolveReplicaFanout(observer)

      let chunkId: string | undefined
      let runningHost = ''
      for (let index = 0; index < MAX_SUBMITS && !chunkId; index++) {
        // A new client is a new connection, which the load balancer may send to
        // any replica.
        const submitter = createLiveExecutor(env)
        submitters.push(submitter)
        const candidate = `c${index}`
        const queryId = `backfill-${planId}-${candidate}`
        attempts.push(submitter.submit(CHUNK_SQL, queryId).catch(() => undefined))
        const hosts = await pollUntil(
          () => runningHosts(observer, fanout, queryId),
          (found) => found.length > 0,
          { intervalMs: 100 },
        )
        runningHost = hosts[0] ?? ''
        if (!fanout || runningHost !== observerHost) chunkId = candidate
      }
      expect(chunkId, `a chunk running on a replica other than ${observerHost} within ${MAX_SUBMITS} submits`).toBeDefined()
      const resumedChunk = chunkId as string
      const queryId = `backfill-${planId}-${resumedChunk}`

      const submits: string[] = []
      const snapshots: BackfillChunkState[] = []
      const executor: ClickHouseExecutor = {
        ...observer,
        query: (sql, settings) => observer.query(sql, settings),
        queryStatus: (id, options) => observer.queryStatus(id, options),
        submit: async (sql, id) => {
          submits.push(id ?? sql)
          return observer.submit(sql, id)
        },
      }

      const result = await executeBackfill({
        executor,
        planId,
        chunks: [{ id: resumedChunk }],
        buildQuery: () => CHUNK_SQL,
        pollIntervalMs: 250,
        // A run that stopped between submitting the chunk and recording it.
        resumeFrom: { [resumedChunk]: { status: 'pending' } },
        onProgress: (progress) => {
          const state = progress[resumedChunk]
          if (state) snapshots.push(state)
        },
      })

      expect(snapshots[0], `resume state of ${queryId} running on ${runningHost}`).toMatchObject({
        status: 'running',
        queryId,
      })
      expect(submits).toEqual([])
      expect(result.progress[resumedChunk]?.status).toBe('done')
    } finally {
      await Promise.all(attempts)
      await Promise.all([observer, ...submitters].map((executor) => executor.close()))
    }
  }, 180_000)
})

async function hostOf(executor: ClickHouseExecutor): Promise<string> {
  const [row] = await executor.query<{ host: string }>('SELECT hostName() AS host')
  return row?.host ?? ''
}

async function runningHosts(
  executor: ClickHouseExecutor,
  fanout: ReplicaFanout | undefined,
  queryId: string,
): Promise<string[]> {
  const source = fanout ? allReplicas(fanout, 'system.processes') : 'system.processes'
  const rows = await executor.query<{ host: string }>(
    `SELECT hostName() AS host FROM ${source} WHERE query_id = '${queryId}'`,
  )
  return rows.map((row) => row.host)
}
