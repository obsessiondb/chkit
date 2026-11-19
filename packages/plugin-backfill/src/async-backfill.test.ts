import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { createStatelessClickHouseExecutor, sendNotAdmittedError, type ClickHouseExecutor, type QueryStatus, type SubmitAdmission } from '@chkit/clickhouse'
import { BackfillInterruptedError, CHECKPOINT_VERSION, executeBackfill, syncProgress, type BackfillProgress } from './async-backfill.js'

const PLAN_ID = 'test-plan'

/**
 * A scripted server: each query id walks through its list of statuses. A
 * `running` status is in system.processes, and a read of it there moves the
 * id to its next status; a `finished` or `failed` one is a
 * QueryFinish or ExceptionWhileProcessing row in system.query_log. A key
 * ending in `-*` scripts every id with that prefix (a replay's random id).
 */
function createMockExecutor(statuses: Map<string, QueryStatus[]>): ClickHouseExecutor {
  const cursors = new Map<string, number>()
  const scriptOf = (queryId: string) => {
    const exact = statuses.get(queryId)
    if (exact) return exact
    const wildcard = [...statuses.keys()].find((key) => key.endsWith('-*') && queryId.startsWith(key.slice(0, -1)))
    return wildcard ? statuses.get(wildcard) : undefined
  }
  const current = (queryId: string): QueryStatus => {
    const list = scriptOf(queryId) ?? [{ status: 'unknown' }]
    return list[Math.min(cursors.get(queryId) ?? 0, list.length - 1)] as QueryStatus
  }
  const idsIn = (sql: string): string[] => {
    const exact = /query_id IN \(([^)]*)\)/.exec(sql)
    if (exact?.[1]) return [...exact[1].matchAll(/'([^']*)'/g)].map((match) => match[1] as string)
    return [...statuses.keys()].filter((key) => !key.endsWith('-*'))
  }
  const logRow = (queryId: string, qs: QueryStatus) => ({
    query_id: queryId,
    type: qs.status === 'finished' ? 'QueryFinish' : 'ExceptionWhileProcessing',
    written_rows: String(qs.status === 'finished' ? qs.writtenRows ?? 0 : 0),
    written_bytes: String(qs.status === 'finished' ? qs.writtenBytes ?? 0 : 0),
    query_duration_ms: String('durationMs' in qs ? qs.durationMs ?? 0 : 0),
    exception: qs.status === 'failed' ? qs.error ?? '' : '',
  })

  return {
    async command() {},
    async query<T>(sql: string): Promise<T[]> {
      // A replay reads the server time for its query_log bound.
      if (sql.includes('now64')) return [{ now_ms: String(Date.now()) }] as T[]
      // One replica, which answers the strict probe.
      if (sql.includes('system.one')) return [{ replicas: '1' }] as T[]
      if (sql.includes('system.processes')) {
        return idsIn(sql).flatMap((id) => {
          const qs = current(id)
          if (qs.status !== 'running') return []
          cursors.set(id, (cursors.get(id) ?? 0) + 1)
          return [{
            query_id: id,
            read_rows: String(qs.readRows ?? 0),
            read_bytes: String(qs.readBytes ?? 0),
            written_rows: String(qs.writtenRows ?? 0),
            written_bytes: String(qs.writtenBytes ?? 0),
            elapsed: (qs.elapsedMs ?? 0) / 1000,
          }]
        }) as T[]
      }
      if (sql.includes('system.query_log')) {
        return idsIn(sql).flatMap((id) => {
          const qs = current(id)
          return qs.status === 'finished' || qs.status === 'failed' ? [logRow(id, qs)] : []
        }) as T[]
      }
      return [] as T[]
    },
    async insert() {},
    async listSchemaObjects() { return [] },
    async listTableDetails() { return [] },
    // Sends once, and asks the admission as the request is created.
    submitSendsOnce: true,
    async submit(_sql: string, queryId?: string, _settings?: unknown, admission?: SubmitAdmission): Promise<string> {
      if (admission && !admission.admit()) throw sendNotAdmittedError()
      admission?.handedOff?.()
      return queryId ?? crypto.randomUUID()
    },
    // Backfill reads status through query(), on every replica.
    async queryStatus(): Promise<QueryStatus> {
      throw new Error('queryStatus is not used')
    },
    async close() {},
  }
}

describe('executeBackfill', () => {
  const chunks = [
    { id: 'c1', from: '2024-01-01', to: '2024-01-02' },
    { id: 'c2', from: '2024-01-02', to: '2024-01-03' },
  ]

  test('completes all chunks', async () => {
    const statuses = new Map<string, QueryStatus[]>([
      [`backfill-${PLAN_ID}-c1`, [{ status: 'running' }, { status: 'finished', writtenRows: 100, writtenBytes: 500, durationMs: 200 }]],
      [`backfill-${PLAN_ID}-c2`, [{ status: 'finished', writtenRows: 50, writtenBytes: 250, durationMs: 100 }]],
    ])

    const result = await executeBackfill({
      executor: createMockExecutor(statuses),
      planId: PLAN_ID,
      chunks,
      buildQuery: (c) => `INSERT INTO t SELECT * FROM s WHERE d >= '${c.from}' AND d < '${c.to}'`,
      concurrency: 2,
      pollIntervalMs: 10,
    })

    expect(result.total).toBe(2)
    expect(result.completed).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.progress.c1.status).toBe('done')
    expect(result.progress.c2.status).toBe('done')
    expect(result.progress.c1.writtenRows).toBe(100)
  })

  test('reports failed chunks', async () => {
    const statuses = new Map<string, QueryStatus[]>([
      [`backfill-${PLAN_ID}-c1`, [{ status: 'failed', error: 'OOM', durationMs: 50 }]],
      [`backfill-${PLAN_ID}-c2`, [{ status: 'finished', writtenRows: 10, writtenBytes: 40, durationMs: 30 }]],
    ])

    const result = await executeBackfill({
      executor: createMockExecutor(statuses),
      planId: PLAN_ID,
      chunks,
      buildQuery: () => 'SELECT 1',
      concurrency: 2,
      pollIntervalMs: 10,
      // A failure is recorded on the read after this flush window.
      outcomeRecheckAttempts: 1,
      outcomeRecheckIntervalMs: 20,
    })

    expect(result.completed).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.progress.c1.status).toBe('failed')
    expect(result.progress.c1.error).toBe('OOM')
    expect(result.progress.c2.status).toBe('done')
  })

  test('respects concurrency limit', async () => {
    const submitOrder: string[] = []
    const statuses = new Map<string, QueryStatus[]>([
      [`backfill-${PLAN_ID}-c1`, [{ status: 'running' }, { status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]],
      [`backfill-${PLAN_ID}-c2`, [{ status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]],
    ])

    const executor = createMockExecutor(statuses)
    const originalSubmit = executor.submit.bind(executor)
    executor.submit = async (sql: string, queryId?: string) => {
      const id = await originalSubmit(sql, queryId)
      submitOrder.push(id)
      return id
    }

    const result = await executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks,
      buildQuery: () => 'SELECT 1',
      concurrency: 1,
      pollIntervalMs: 10,
    })

    expect(result.total).toBe(2)
    expect(result.completed).toBe(2)
    expect(submitOrder[0]).toBe(`backfill-${PLAN_ID}-c1`)
    expect(submitOrder[1]).toBe(`backfill-${PLAN_ID}-c2`)
  })

  test('calls onProgress on state changes', async () => {
    const statuses = new Map<string, QueryStatus[]>([
      [`backfill-${PLAN_ID}-c1`, [{ status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]],
    ])

    const progressSnapshots: BackfillProgress[] = []

    await executeBackfill({
      executor: createMockExecutor(statuses),
      planId: PLAN_ID,
      chunks: [chunks[0]],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      onProgress: (p) => { progressSnapshots.push({ ...p }) },
    })

    expect(progressSnapshots.length).toBeGreaterThanOrEqual(1)
    const lastSnapshot = progressSnapshots[progressSnapshots.length - 1]
    expect(lastSnapshot.c1.status).toBe('done')
  })

  test('reports intermediate metrics while running', async () => {
    const statuses = new Map<string, QueryStatus[]>([
      [`backfill-${PLAN_ID}-c1`, [
        { status: 'running', readRows: 100, readBytes: 400, writtenRows: 0, writtenBytes: 0, elapsedMs: 1000 },
        { status: 'running', readRows: 500, readBytes: 2000, writtenRows: 50, writtenBytes: 200, elapsedMs: 3000 },
        { status: 'finished', writtenRows: 200, writtenBytes: 800, durationMs: 5000 },
      ]],
    ])

    const progressSnapshots: BackfillProgress[] = []

    await executeBackfill({
      executor: createMockExecutor(statuses),
      planId: PLAN_ID,
      chunks: [chunks[0]],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      onProgress: (p) => { progressSnapshots.push(structuredClone(p)) },
    })

    // Should have at least 3 progress calls: submitted, running (with metrics), done
    expect(progressSnapshots.length).toBeGreaterThanOrEqual(3)

    // Find the running snapshots with metrics
    const runningSnapshots = progressSnapshots.filter((p) => p.c1.status === 'running')
    expect(runningSnapshots.length).toBe(2)
    expect(runningSnapshots[0].c1.readRows).toBe(100)
    expect(runningSnapshots[0].c1.elapsedMs).toBe(1000)
    expect(runningSnapshots[1].c1.readRows).toBe(500)
    expect(runningSnapshots[1].c1.writtenRows).toBe(50)
    expect(runningSnapshots[1].c1.elapsedMs).toBe(3000)

    // Final snapshot should be done
    const lastSnapshot = progressSnapshots[progressSnapshots.length - 1]
    expect(lastSnapshot.c1.status).toBe('done')
    expect(lastSnapshot.c1.writtenRows).toBe(200)
  })

  test('resumes from saved progress', async () => {
    const queryId = `backfill-${PLAN_ID}-c2`
    const statuses = new Map<string, QueryStatus[]>([
      [queryId, [{ status: 'finished', writtenRows: 50, writtenBytes: 250, durationMs: 100 }]],
    ])

    const resumeFrom: BackfillProgress = {
      c1: { status: 'done', queryId: `backfill-${PLAN_ID}-c1`, writtenRows: 100 },
      c2: { status: 'submitted', queryId, submittedAt: '2024-01-01T00:00:00Z' },
    }

    const result = await executeBackfill({
      executor: createMockExecutor(statuses),
      planId: PLAN_ID,
      chunks,
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      resumeFrom,
    })

    expect(result.completed).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.progress.c1.status).toBe('done')
    expect(result.progress.c1.writtenRows).toBe(100)
  })

  test('handles transient poll errors gracefully', async () => {
    let logReads = 0
    const executor = createMockExecutor(new Map([[`backfill-${PLAN_ID}-c1`, [{ status: 'finished', writtenRows: 10, writtenBytes: 40, durationMs: 30 }]]]))
    const query = executor.query.bind(executor)
    executor.query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('system.query_log') && ++logReads <= 2) throw new Error('ECONNRESET')
      return query<T>(sql)
    }

    const result = await executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [chunks[0]],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      maxPollErrors: 5,
    })

    expect(result.completed).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.progress.c1.status).toBe('done')
  })

  // #765: losing contact is no evidence that the chunk failed, and a failed
  // chunk is what --replay-failed runs again. No chunk starts after it.
  test('a polling outage stops the run after the chunk in flight, without recording it failed', async () => {
    const submits: string[] = []
    const executor = createMockExecutor(new Map())
    executor.query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('system.processes')) throw new Error('ETIMEDOUT')
      return [] as T[]
    }
    executor.submit = async (_sql, queryId) => {
      submits.push(queryId ?? '')
      return queryId ?? ''
    }
    const saved: BackfillProgress[] = []

    await expect(
      executeBackfill({
        executor,
        planId: PLAN_ID,
        chunks: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
        buildQuery: () => 'SELECT 1',
        concurrency: 1,
        pollIntervalMs: 10,
        maxPollErrors: 3,
        onProgress: (progress) => { saved.push(progress) },
      }),
    ).rejects.toThrow(
      `Backfill plan ${PLAN_ID}: the outcome of the last attempt is unknown for chunk c1 (query_id backfill-${PLAN_ID}-c1): lost contact with the server after 3 consecutive poll errors (ETIMEDOUT). A chunk whose outcome is unknown is not submitted again, as it may have written its rows. Re-run the resume once system.query_log records the outcome, or pass --accept-unknown to replay it under a new query id, which can write its rows twice.`,
    )
    expect(submits).toEqual([`backfill-${PLAN_ID}-c1`])
    expect(saved.at(-1)).toEqual({
      c1: { status: 'submitted', queryId: `backfill-${PLAN_ID}-c1`, singleSend: true },
      c2: { status: 'pending' },
      c3: { status: 'pending' },
    })
  })

  test('replayFailed replays a chunk the server shows failed under a new id', async () => {
    const queryId = `backfill-${PLAN_ID}-c1`
    const statuses = new Map<string, QueryStatus[]>([
      [queryId, [{ status: 'failed', error: 'OOM', durationMs: 5 }]],
      [`${queryId}-*`, [{ status: 'finished', writtenRows: 42, writtenBytes: 200, durationMs: 80 }]],
      [`backfill-${PLAN_ID}-c2`, [{ status: 'finished', writtenRows: 10, writtenBytes: 50, durationMs: 20 }]],
    ])

    const resumeFrom: BackfillProgress = {
      c1: { status: 'failed', queryId, error: 'OOM', singleSend: true },
      c2: { status: 'done', queryId: `backfill-${PLAN_ID}-c2`, writtenRows: 10 },
    }

    const result = await executeBackfill({
      executor: createMockExecutor(statuses),
      planId: PLAN_ID,
      chunks,
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      resumeFrom,
      checkpointVersion: CHECKPOINT_VERSION,
      replayFailed: true,
    })

    expect(result.completed).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.progress.c1.status).toBe('done')
    expect(result.progress.c1.queryId?.startsWith(`${queryId}-`)).toBe(true)
    expect(result.progress.c1.writtenRows).toBe(42)
  })

  test('a first attempt records its query id before its submit', async () => {
    const saved: BackfillProgress[] = []
    const executor = createMockExecutor(new Map([[`backfill-${PLAN_ID}-c1`, [{ status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]]]))
    executor.submit = async (_sql, queryId) => {
      // A run that stops while the INSERT runs must not leave a chunk that
      // looks never submitted: a resume would submit it a second time.
      expect(saved.at(-1)?.c1).toEqual({ status: 'pending', queryId: `backfill-${PLAN_ID}-c1`, singleSend: true })
      return queryId ?? ''
    }

    const result = await executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [chunks[0]],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      onProgress: (progress) => { saved.push(progress) },
    })

    expect(result.progress.c1.status).toBe('done')
  })
})

describe('syncProgress', () => {
  const chunks = [
    { id: 'c1' },
    { id: 'c2' },
    { id: 'c3' },
  ]

  test('discovers submitted-but-untracked queries from server', async () => {
    const executor = createMockExecutor(new Map())
    // Mock query() to return server-side state
    executor.query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('system.processes')) {
        return [{ query_id: `backfill-${PLAN_ID}-c2` }] as T[]
      }
      if (sql.includes('system.query_log')) {
        return [{
          query_id: `backfill-${PLAN_ID}-c1`,
          type: 'QueryFinish',
          written_rows: '500',
          written_bytes: '2000',
          query_duration_ms: '150',
          exception: '',
        }] as T[]
      }
      return [] as T[]
    }

    const progress: BackfillProgress = {
      c1: { status: 'pending' },
      c2: { status: 'pending' },
      c3: { status: 'pending' },
    }

    const synced = await syncProgress(executor, PLAN_ID, chunks, progress)

    // c1 was found completed in query_log
    expect(synced.c1.status).toBe('done')
    expect(synced.c1.writtenRows).toBe(500)
    // c2 was found running in system.processes
    expect(synced.c2.status).toBe('running')
    expect(synced.c2.queryId).toBe(`backfill-${PLAN_ID}-c2`)
    // c3 had no server state — stays pending
    expect(synced.c3.status).toBe('pending')
  })

  test('does not downgrade done chunks', async () => {
    const executor = createMockExecutor(new Map())
    executor.query = async <T>(): Promise<T[]> => [] as T[]

    const progress: BackfillProgress = {
      c1: { status: 'done', queryId: `backfill-${PLAN_ID}-c1`, writtenRows: 100 },
    }

    const synced = await syncProgress(executor, PLAN_ID, [{ id: 'c1' }], progress)
    expect(synced.c1.status).toBe('done')
    expect(synced.c1.writtenRows).toBe(100)
  })

  // One read never proves a failure: a replica that flushes late could still
  // show a row that turns it unknown. executeBackfill reads it again.
  test('leaves a failure it reads once unsettled', async () => {
    const executor = createMockExecutor(new Map())
    executor.query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('system.one')) return [{ replicas: '1' }] as T[]
      if (sql.includes('system.processes')) return [] as T[]
      if (sql.includes('system.query_log')) {
        return [{
          query_id: `backfill-${PLAN_ID}-c1`,
          type: 'ExceptionWhileProcessing',
          written_rows: '0',
          written_bytes: '0',
          query_duration_ms: '10',
          exception: 'Memory limit exceeded',
        }] as T[]
      }
      return [] as T[]
    }

    const progress: BackfillProgress = {
      c1: { status: 'submitted', queryId: `backfill-${PLAN_ID}-c1`, singleSend: true },
    }

    const synced = await syncProgress(executor, PLAN_ID, [{ id: 'c1' }], progress)
    expect(synced.c1).toEqual(progress.c1)
  })

  // Round 3: a probe with no replica count proves nothing about the replicas,
  // so the reads are local and the clustered source of the executor unused.
  test('reads the local tables when the replica probe returns no count', async () => {
    const queries: string[] = []
    const executor = createMockExecutor(new Map())
    executor.systemTableSource = (table) =>
      `clusterAllReplicas('moebel_cluster', system.${table})`
    executor.query = async <T>(sql: string): Promise<T[]> => {
      queries.push(sql)
      return [] as T[]
    }

    await syncProgress(
      executor,
      PLAN_ID,
      [{ id: 'c1' }],
      { c1: { status: 'pending' } },
    )

    const [processes, queryLog] = statusReads(queries)
    expect(queries[0]).toContain("FROM clusterAllReplicas('default', system.one) SETTINGS skip_unavailable_shards = 0")
    expect(processes).toContain('FROM system.processes')
    expect(queryLog).toContain('FROM system.query_log')
    expect(queries.join('\n')).not.toContain("clusterAllReplicas('moebel_cluster'")
  })

  test('falls back to local system tables when capability is absent', async () => {
    const queries: string[] = []
    const executor = createMockExecutor(new Map())
    executor.query = async <T>(sql: string): Promise<T[]> => {
      queries.push(sql)
      return [] as T[]
    }

    await syncProgress(
      executor,
      PLAN_ID,
      [{ id: 'c1' }],
      { c1: { status: 'pending' } },
    )

    const [processes, queryLog] = statusReads(queries)
    expect(processes).toContain('FROM system.processes')
    expect(processes).not.toContain('clusterAllReplicas')
    expect(queryLog).toContain('FROM system.query_log')
    expect(queryLog).not.toContain('clusterAllReplicas')
  })

  test('observable fallback still works when systemTableSource is undefined', async () => {
    const queries: string[] = []
    const executor = createMockExecutor(new Map())
    // Explicitly no capability (default mock omits it)
    expect(executor.systemTableSource).toBeUndefined()
    executor.query = async <T>(sql: string): Promise<T[]> => {
      queries.push(sql)
      if (sql.includes('system.processes')) {
        return [{ query_id: `backfill-${PLAN_ID}-c1` }] as T[]
      }
      return [] as T[]
    }

    const synced = await syncProgress(
      executor,
      PLAN_ID,
      [{ id: 'c1' }],
      { c1: { status: 'pending' } },
    )

    expect(synced.c1.status).toBe('running')
    expect(statusReads(queries)[0]).toMatch(/FROM system\.processes/)
  })

  // #289: a chunk query runs on the replica that received it. Resume submits
  // every chunk this read does not find, so it reads each replica.
  test('reads every replica of a multi-replica target without clickhouse.cluster', async () => {
    const queries: string[] = []
    const executor = createMockExecutor(new Map())
    executor.query = async <T>(sql: string): Promise<T[]> => {
      queries.push(sql)
      if (sql.includes('system.one')) return [{ replicas: '2' }] as T[]
      if (sql.includes('system.processes')) return [{ query_id: `backfill-${PLAN_ID}-c1` }] as T[]
      return [] as T[]
    }

    const synced = await syncProgress(executor, PLAN_ID, [{ id: 'c1' }], { c1: { status: 'pending' } })

    expect(synced.c1.status).toBe('running')
    expect(queries[0]).toContain("FROM clusterAllReplicas('default', system.one)")
    const [processes, queryLog] = statusReads(queries)
    expect(processes).toContain("FROM clusterAllReplicas('default', system.processes)")
    expect(queryLog).toContain("FROM clusterAllReplicas('default', system.query_log)")
    // A replica that cannot be read fails the read instead of being skipped.
    expect(processes).toContain('SETTINGS skip_unavailable_shards = 0')
    expect(queryLog).toContain('SETTINGS skip_unavailable_shards = 0')
  })

  test('fails instead of reporting a chunk not running when a replica cannot be read', async () => {
    const executor = createMockExecutor(new Map())
    executor.query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('system.one')) return [{ replicas: '2' }] as T[]
      if (sql.includes('system.processes')) throw new Error('Code: 279. ALL_CONNECTION_TRIES_FAILED')
      return [] as T[]
    }

    await expect(
      syncProgress(executor, PLAN_ID, [{ id: 'c1' }], { c1: { status: 'pending' } }),
    ).rejects.toThrow(
      `Backfill plan ${PLAN_ID}: could not check which chunks are still running on the server (Code: 279. ALL_CONNECTION_TRIES_FAILED). Nothing was submitted`,
    )
  })
})

describe('executeBackfill resume across replicas (#289)', () => {
  test('reads the replicas of the configured cluster and attaches to a chunk running on one', async () => {
    const queryId = `backfill-${PLAN_ID}-c1`
    const queries: string[] = []
    const submits: string[] = []
    const executor = createMockExecutor(new Map())
    let processReads = 0
    executor.query = async <T>(sql: string): Promise<T[]> => {
      queries.push(sql)
      if (sql.includes("clusterAllReplicas('analytics', system.one)")) return [{ replicas: '4' }] as T[]
      // Running at the resume's read, finished by the first poll.
      if (sql.includes("clusterAllReplicas('analytics', system.processes)")) {
        return (++processReads === 1 ? [{ query_id: queryId }] : []) as T[]
      }
      if (sql.includes("clusterAllReplicas('analytics', system.query_log)") && processReads > 1) {
        return [{ query_id: queryId, type: 'QueryFinish', written_rows: '7', written_bytes: '0', query_duration_ms: '1', exception: '' }] as T[]
      }
      return [] as T[]
    }
    executor.submit = async (_sql, id) => {
      submits.push(id ?? '')
      return id ?? ''
    }

    const result = await executeBackfill({
      executor,
      cluster: 'analytics',
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      // A run that crashed between submit and its state write.
      resumeFrom: { c1: { status: 'pending' } },
    })

    expect(submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId, writtenRows: 7 })
    expect(queries.join('\n')).not.toContain("clusterAllReplicas('default'")
  })

  test('submits nothing when the resume cannot read a replica', async () => {
    const submits: string[] = []
    const executor = createMockExecutor(new Map())
    executor.query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('system.one')) return [{ replicas: '2' }] as T[]
      if (sql.includes('system.query_log')) throw new Error('Code: 210. NETWORK_ERROR')
      return [] as T[]
    }
    executor.submit = async (_sql, id) => {
      submits.push(id ?? '')
      return id ?? ''
    }

    await expect(
      executeBackfill({
        executor,
        planId: PLAN_ID,
        chunks: [{ id: 'c1' }, { id: 'c2' }],
        buildQuery: () => 'SELECT 1',
        pollIntervalMs: 10,
        resumeFrom: { c1: { status: 'failed', error: 'Lost contact' }, c2: { status: 'pending' } },
        replayFailed: true,
      }),
    ).rejects.toThrow('could not check which chunks are still running on the server (Code: 210. NETWORK_ERROR)')
    expect(submits).toEqual([])
  })
})

// The processes and query_log reads, without the replica probe before them.
function statusReads(queries: string[]): string[] {
  return queries.filter((sql) => sql.includes('system.processes') || sql.includes('system.query_log'))
}

// A ClickHouse stand-in with the timing that matters for a replay (#765). An
// attempt the run submits is in system.processes for `runningReads` reads of
// system.processes, then logged once `unflushedLogReads` more query_log reads
// have passed: the flush gap. An attempt that ended before the run starts is
// logged after `hiddenLogReads` query_log reads (Infinity: never, as with
// log_queries = 0 or a log that has not flushed). Earlier attempts' rows stay
// visible throughout. The time probe answers `clockOffsetMs` from the
// client's clock; the replica that runs a submitted attempt stamps it
// `submitClockOffsetMs` from it. A query_log read pruned by event_date hides
// the rows of attempts that started before that day.
// `partial` fails after writing rows, as a late block's failure does.
type SimOutcome = 'finished' | 'failed' | 'partial' | 'started'

interface SimAttempt {
  queryId: string
  startMs: number
  outcome: SimOutcome
  runningReads: number
  statusReads: number
  loggedAtLogRead: number
}

const DAY_MS = 24 * 60 * 60_000

function createSimulatedServer(options: {
  nextOutcomes?: SimOutcome[]
  attempts?: Array<{ queryId: string; outcome: SimOutcome; startMs?: number; running?: number; hiddenLogReads?: number }>
  clockOffsetMs?: number
  submitClockOffsetMs?: number
  unflushedLogReads?: number
}) {
  const serverNow = () => Date.now() + (options.clockOffsetMs ?? 0)
  const nextOutcomes = [...(options.nextOutcomes ?? [])]
  const attempts: SimAttempt[] = (options.attempts ?? []).map((attempt) => ({
    queryId: attempt.queryId,
    outcome: attempt.outcome,
    startMs: attempt.startMs ?? serverNow(),
    runningReads: attempt.running ?? 0,
    statusReads: 0,
    loggedAtLogRead: attempt.hiddenLogReads ?? 0,
  }))
  const submits: string[] = []
  const persisted: BackfillProgress[] = []
  const logQueries: string[] = []
  let logReads = 0
  const isRunning = (attempt: SimAttempt) => attempt.statusReads < attempt.runningReads
  const isLogged = (attempt: SimAttempt) => !isRunning(attempt) && logReads > attempt.loggedAtLogRead
  // Latest first, as the reader orders by event_time DESC.
  const logged = () => attempts.filter(isLogged).reverse()
  const logRows = (attempt: SimAttempt) => {
    const base = { query_id: attempt.queryId }
    const start = { ...base, type: 'QueryStart', written_rows: '0', written_bytes: '0', query_duration_ms: '0', exception: '' }
    if (attempt.outcome === 'started') return [start]
    const end = attempt.outcome === 'finished'
      ? { ...base, type: 'QueryFinish', written_rows: '42', written_bytes: '0', query_duration_ms: '1', exception: '' }
      : { ...base, type: 'ExceptionWhileProcessing', written_rows: attempt.outcome === 'partial' ? '42' : '0', written_bytes: '0', query_duration_ms: '1', exception: 'Code: 394. QUERY_WAS_CANCELLED' }
    return [end, start]
  }
  const matches = (sql: string, queryId: string) => {
    const exact = /query_id IN \(([^)]*)\)/.exec(sql)
    return exact?.[1] ? exact[1].includes(`'${queryId}'`) : true
  }
  // event_date >= toDate32(after) - 1
  const prunedBefore = (sql: string) => {
    const after = /event_date >= toDate32\(parseDateTimeBestEffort\('([^']*)'\)\) - 1/.exec(sql)?.[1]
    return after ? Math.floor(Date.parse(after) / DAY_MS) * DAY_MS - DAY_MS : undefined
  }

  const executor = createMockExecutor(new Map())
  executor.submit = async (_sql, queryId, _settings, admission) => {
    if (admission && !admission.admit()) throw sendNotAdmittedError()
      admission?.handedOff?.()
    const id = queryId ?? crypto.randomUUID()
    submits.push(id)
    // The attempt's id is durable before its submit.
    const saved = persisted.at(-1)?.c1
    if (saved?.status !== 'pending' || saved.queryId !== id) {
      throw new Error(`submitted ${id} before the checkpoint recorded it (saved: ${JSON.stringify(saved)})`)
    }
    const outcome = nextOutcomes.shift()
    if (!outcome) throw new Error(`unexpected submit of ${id}`)
    attempts.push({
      queryId: id,
      startMs: Date.now() + (options.submitClockOffsetMs ?? options.clockOffsetMs ?? 0),
      outcome,
      runningReads: 1,
      statusReads: 0,
      loggedAtLogRead: logReads + (options.unflushedLogReads ?? 1),
    })
    return id
  }
  executor.query = async <T>(sql: string): Promise<T[]> => {
    if (sql.includes('now64')) return [{ now_ms: String(serverNow()) }] as T[]
    if (sql.includes('system.one')) return [{ replicas: '1' }] as T[]
    if (sql.includes('system.processes')) {
      const running = attempts.filter((attempt) => isRunning(attempt) && matches(sql, attempt.queryId))
      for (const attempt of running) attempt.statusReads += 1
      return running.map((attempt) => ({ query_id: attempt.queryId, read_rows: '0', read_bytes: '0', written_rows: '0', written_bytes: '0', elapsed: 0 })) as T[]
    }
    if (sql.includes('system.query_log')) {
      logReads += 1
      logQueries.push(sql)
      const floor = prunedBefore(sql)
      return logged()
        .filter((attempt) => matches(sql, attempt.queryId) && (floor === undefined || attempt.startMs >= floor))
        .flatMap(logRows) as T[]
    }
    return [] as T[]
  }
  return { executor, submits, persisted, logQueries }
}

describe('executeBackfill replays under a query id of their own (#765)', () => {
  const firstId = `backfill-${PLAN_ID}-c1`
  const recordedReplayId = `${firstId}-recorded`
  const hourAgo = () => new Date(Date.now() - 60 * 60_000).toISOString()
  // The killed first attempt, seconds before the replay: its failure is newer
  // than the 60 s window older releases subtracted from the replay's start.
  const killedFirst = { queryId: firstId, outcome: 'failed' as const, startMs: Date.now() - 5_000 }
  const unknownError = (queryId: string, reason: string) =>
    `Backfill plan ${PLAN_ID}: the outcome of the last attempt is unknown for chunk c1 (query_id ${queryId}): ${reason}. A chunk whose outcome is unknown is not submitted again, as it may have written its rows. Re-run the resume once system.query_log records the outcome, or pass --accept-unknown to replay it under a new query id, which can write its rows twice.`
  const NO_OUTCOME = 'it is not running on any replica and system.query_log has no outcome for it'
  const SHARED_ID = 'an older release ran it under the chunk\'s shared query id, so the failure in system.query_log may be an earlier attempt\'s'
  const runOnce = (
    server: ReturnType<typeof createSimulatedServer>,
    resumeFrom: BackfillProgress | undefined,
    extra: { replayFailed?: boolean; acceptUnknown?: boolean; maxPollErrors?: number; outcomeRecheckIntervalMs?: number; checkpointVersion?: number } = {},
  ) =>
    executeBackfill({
      executor: server.executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 1,
      outcomeRecheckAttempts: 3,
      outcomeRecheckIntervalMs: 1,
      resumeFrom,
      // Progress this release saved, unless a test passes another format.
      checkpointVersion: CHECKPOINT_VERSION,
      onProgress: (progress) => {
        server.persisted.push(progress)
      },
      ...extra,
    })

  test('a replay started seconds after the failure ends done when its attempt finishes', async () => {
    const server = createSimulatedServer({ attempts: [killedFirst], nextOutcomes: ['finished'] })

    const result = await runOnce(
      server,
      { c1: { status: 'failed', queryId: firstId, singleSend: true, error: 'Code: 394. QUERY_WAS_CANCELLED' } },
      { replayFailed: true },
    )

    // Releases that reused the first id read its failure while the replay ran.
    expect(result.progress.c1?.status).toBe('done')
    expect(server.submits).toHaveLength(1)
    const replayId = server.submits[0]
    expect(replayId).not.toBe(firstId)
    expect(replayId?.startsWith(`${firstId}-`)).toBe(true)
    expect(result.failed).toBe(0)
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: replayId, writtenRows: 42 })
  })

  test('a resume in the flush gap of a replay that committed records it done without running it again', async () => {
    // The run died while the replay's submit waited for the INSERT, which
    // then committed; its QueryFinish is not in query_log at the first read.
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'finished', hiddenLogReads: 1 }],
    })

    const result = await runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: recordedReplayId, writtenRows: 42 })
  })

  test('a resume in the flush gap of a replay that failed records it failed without running it', async () => {
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'failed', hiddenLogReads: 1 }],
    })

    const result = await runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'failed', queryId: recordedReplayId })
  })

  // Finding 1: query_log can flush after the recheck window, or not at all,
  // so no row is no proof that a recorded attempt never ran.
  test('a recorded attempt with no row in query_log after the window stops the resume, and --accept-unknown replays it under a new id', async () => {
    for (const recorded of [
      { status: 'pending' as const, queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true },
      { status: 'pending' as const, queryId: firstId },
    ]) {
      const server = createSimulatedServer({
        attempts: [{ queryId: recorded.queryId, outcome: 'finished', hiddenLogReads: Number.POSITIVE_INFINITY }],
        nextOutcomes: ['finished'],
      })

      await expect(runOnce(server, { c1: recorded })).rejects.toThrow(unknownError(recorded.queryId, NO_OUTCOME))
      await expect(runOnce(server, { c1: recorded }, { replayFailed: true })).rejects.toThrow(unknownError(recorded.queryId, NO_OUTCOME))
      expect(server.submits).toEqual([])
      // The last read has no time bound.
      expect(server.logQueries.at(-1)).not.toContain('event_date')

      const accepted = await runOnce(server, { c1: recorded }, { acceptUnknown: true })

      expect(server.submits).toHaveLength(1)
      expect(server.submits[0]).not.toBe(recorded.queryId)
      expect(server.submits[0]?.startsWith(`${firstId}-`)).toBe(true)
      expect(accepted.progress.c1).toMatchObject({ status: 'done', queryId: server.submits[0] })
    }
  })

  // The submit returns when the INSERT ends, so every poll starts in the
  // query_log flush gap. A short poll interval must not shorten the wait.
  test('polls wait out a flush gap longer than maxPollErrors polls, and the attempt ends done', async () => {
    const server = createSimulatedServer({ nextOutcomes: ['finished'], unflushedLogReads: 15 })

    const result = await runOnce(server, undefined, { maxPollErrors: 3, outcomeRecheckIntervalMs: 100 })

    expect(server.submits).toEqual([firstId])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: firstId, writtenRows: 42 })
    expect(server.logQueries.length).toBeGreaterThan(3)
  })

  test('a replay that started and has no outcome stops the resume before anything is submitted', async () => {
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'started' }],
      nextOutcomes: ['finished'],
    })

    for (const replayFailed of [false, true]) {
      await expect(
        runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } }, { replayFailed }),
      ).rejects.toThrow(unknownError(recordedReplayId, NO_OUTCOME))
    }
    expect(server.submits).toEqual([])
  })

  test('a run stopped between the replay submit and its state write attaches to it', async () => {
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'finished', running: 2 }],
    })

    const result = await runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: recordedReplayId })
  })

  test('a resume reads a finished replay by its own id, not the failed first attempt', async () => {
    const server = createSimulatedServer({ attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'finished' }] })

    const result = await runOnce(server, { c1: { status: 'running', queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: recordedReplayId, writtenRows: 42 })
  })

  test('a failed replay keeps its id on a plain resume and is replayed again under a third id', async () => {
    const server = createSimulatedServer({ attempts: [killedFirst], nextOutcomes: ['failed', 'finished'] })

    const first = await runOnce(server, { c1: { status: 'failed', queryId: firstId, singleSend: true } }, { replayFailed: true })
    expect(first.progress.c1).toMatchObject({ status: 'failed', queryId: server.submits[0] })
    const plain = await runOnce(server, first.progress)
    expect(plain.progress.c1).toMatchObject({ status: 'failed', queryId: server.submits[0] })

    const second = await runOnce(server, plain.progress, { replayFailed: true })

    expect(server.submits).toHaveLength(2)
    expect(new Set([firstId, ...server.submits]).size).toBe(3)
    expect(second.progress.c1).toMatchObject({ status: 'done', queryId: server.submits[1] })
  })

  // Round-2 item 7: whether an attempt is unknown never depends on the
  // flags. --replay-failed replays a proved failure, --accept-unknown an
  // unresolved attempt, such as a failure an older release recorded for a
  // polling outage, which the server never showed.
  test('--replay-failed and --accept-unknown each replay their own chunks, in every combination', async () => {
    const lostContact = { status: 'failed' as const, error: 'Lost contact with query after 10 consecutive poll errors' }
    const proved = { status: 'failed' as const, queryId: `backfill-${PLAN_ID}-c2`, singleSend: true }
    const combos = [
      { replayFailed: false, acceptUnknown: false, replayed: undefined },
      { replayFailed: true, acceptUnknown: false, replayed: undefined },
      { replayFailed: false, acceptUnknown: true, replayed: ['c1'] },
      { replayFailed: true, acceptUnknown: true, replayed: ['c1', 'c2'] },
    ]
    for (const combo of combos) {
      const submits: string[] = []
      const executor = createMockExecutor(new Map<string, QueryStatus[]>([
        [`backfill-${PLAN_ID}-c2`, [{ status: 'failed', error: 'OOM', durationMs: 1 }]],
        [`backfill-${PLAN_ID}-c1-*`, [{ status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]],
        [`backfill-${PLAN_ID}-c2-*`, [{ status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]],
      ]))
      const submit = executor.submit.bind(executor)
      executor.submit = (sql, queryId) => {
        submits.push(queryId ?? '')
        return submit(sql, queryId)
      }
      const run = executeBackfill({
        executor,
        planId: PLAN_ID,
        chunks: [{ id: 'c1' }, { id: 'c2' }],
        buildQuery: () => 'SELECT 1',
        pollIntervalMs: 1,
        outcomeRecheckAttempts: 2,
        outcomeRecheckIntervalMs: 1,
        resumeFrom: { c1: lostContact, c2: proved },
        checkpointVersion: CHECKPOINT_VERSION,
        replayFailed: combo.replayFailed,
        acceptUnknown: combo.acceptUnknown,
      })

      if (!combo.replayed) {
        await expect(run).rejects.toThrow(`chunk c1 (query_id backfill-${PLAN_ID}-c1): it is not running on any replica and system.query_log has no outcome for it.`)
        expect(submits).toEqual([])
      } else {
        const result = await run
        expect(submits.map((id) => id.split('-').slice(0, 4).join('-'))).toEqual(combo.replayed.map((id) => `backfill-${PLAN_ID}-${id}`))
        expect(result.progress.c1?.status).toBe('done')
        expect(result.progress.c2?.status).toBe(combo.replayFailed ? 'done' : 'failed')
      }
    }
  })

  // Round-2 item 5: an attempt that failed after writing rows leaves them in
  // the table; a replay writes them again.
  test('a failure after written rows is unknown at once, and only --accept-unknown replays it', async () => {
    const server = createSimulatedServer({
      attempts: [{ queryId: recordedReplayId, outcome: 'partial' }],
      nextOutcomes: ['finished'],
    })
    // In flight when the run stopped: this release never records such a failure.
    const recorded = { c1: { status: 'submitted' as const, queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } }

    await expect(runOnce(server, recorded, { replayFailed: true })).rejects.toThrow(
      unknownError(recordedReplayId, 'it failed after writing 42 rows, which a replay would write again'),
    )
    expect(server.submits).toEqual([])

    const accepted = await runOnce(server, recorded, { acceptUnknown: true })
    expect(server.submits).toHaveLength(1)
    expect(accepted.progress.c1).toMatchObject({ status: 'done', queryId: server.submits[0] })
  })

  test('a run whose chunk fails after written rows stops instead of recording it failed', async () => {
    const server = createSimulatedServer({ nextOutcomes: ['partial'] })

    await expect(runOnce(server, undefined)).rejects.toThrow(
      unknownError(firstId, 'it failed after writing 42 rows, which a replay would write again'),
    )
    // Seen running, then failed: it keeps that state, not failed.
    expect(server.persisted.at(-1)?.c1).toMatchObject({ status: 'running', queryId: firstId })
  })

  // Round-2 item 6: an older release saved a chunk's query id only after its
  // submit returned, so a chunk its checkpoint lists as pending, or not at
  // all, may have run.
  test('an unversioned checkpoint\'s pending or missing chunk with no outcome is unknown; this release\'s is submitted', async () => {
    for (const resumeFrom of [{}, { c1: { status: 'pending' as const } }]) {
      const legacy = createSimulatedServer({
        attempts: [{ queryId: firstId, outcome: 'finished', hiddenLogReads: Number.POSITIVE_INFINITY }],
        nextOutcomes: ['finished'],
      })
      await expect(runOnce(legacy, resumeFrom, { checkpointVersion: undefined })).rejects.toThrow(unknownError(firstId, NO_OUTCOME))
      expect(legacy.submits).toEqual([])
      // Saved in this release's format: recorded as may have run.
      expect(legacy.persisted.at(-1)?.c1).toEqual({ status: 'pending', queryId: firstId })

      const accepted = await runOnce(legacy, resumeFrom, { acceptUnknown: true, checkpointVersion: undefined })
      expect(legacy.submits).toHaveLength(1)
      expect(legacy.submits[0]).not.toBe(firstId)
      expect(accepted.progress.c1?.status).toBe('done')

      const current = createSimulatedServer({ nextOutcomes: ['finished'] })
      const result = await runOnce(current, resumeFrom, { checkpointVersion: CHECKPOINT_VERSION })
      expect(current.submits).toEqual([firstId])
      expect(result.progress.c1?.status).toBe('done')
    }
  })

  test('an unversioned checkpoint\'s chunk that committed is done without a flag', async () => {
    const server = createSimulatedServer({ attempts: [{ queryId: firstId, outcome: 'finished', hiddenLogReads: 1 }] })

    const result = await runOnce(server, { c1: { status: 'pending' } }, { checkpointVersion: undefined })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: firstId })
  })

  // Finding 6: the replica that runs the replay can stamp it days before the
  // replica the bound came from. Pruned reads miss it; the last read does not.
  test('a replay stamped by a replica clock days behind the time probe still settles done', async () => {
    const server = createSimulatedServer({
      attempts: [killedFirst],
      nextOutcomes: ['finished'],
      submitClockOffsetMs: -3 * DAY_MS,
    })

    const result = await runOnce(server, { c1: { status: 'failed', queryId: firstId, singleSend: true } }, { replayFailed: true, maxPollErrors: 4 })

    const replayId = server.submits[0] ?? ''
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: replayId })
    // The bound prunes query_log by event_date: an hour before the server's time.
    const lag = Date.now() - Date.parse(result.progress.c1?.submittedAt ?? '')
    expect(lag).toBeGreaterThan(59 * 60_000)
    expect(lag).toBeLessThan(61 * 60_000)
    expect(server.logQueries.some((sql) => sql.includes('event_date'))).toBe(true)
  })

  test('a resume after the same skew settles a recorded replay done', async () => {
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'finished', startMs: Date.now() - 3 * DAY_MS, hiddenLogReads: 1 }],
    })

    const result = await runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: recordedReplayId })
  })

  // Finding 2: an older release replayed under the chunk's id, so the first
  // attempt's failure is a row of the replay's id too.
  test('an older release\'s shared-id replay with only a failure in query_log is unknown, not failed', async () => {
    const submittedAt = new Date(Date.now() - 60_000).toISOString()
    const server = createSimulatedServer({ attempts: [killedFirst], nextOutcomes: ['finished'] })

    for (const resumeFrom of [
      { c1: { status: 'pending' as const, submittedAt } },
      { c1: { status: 'failed' as const, queryId: firstId, submittedAt } },
    ]) {
      await expect(runOnce(server, resumeFrom, { replayFailed: true })).rejects.toThrow(unknownError(firstId, SHARED_ID))
    }
    expect(server.submits).toEqual([])

    const accepted = await runOnce(server, { c1: { status: 'pending', submittedAt } }, { acceptUnknown: true })

    expect(server.submits).toHaveLength(1)
    expect(server.submits[0]).not.toBe(firstId)
    expect(accepted.progress.c1).toMatchObject({ status: 'done', queryId: server.submits[0] })
  })

  test('an older release\'s shared-id replay seen running is not taken for the earlier failure once it stops', async () => {
    const submittedAt = new Date(Date.now() - 60_000).toISOString()
    // Running at the resume's read; its QueryFinish appears a few log reads
    // after it leaves system.processes, while the first failure is visible.
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: firstId, outcome: 'finished', running: 1, hiddenLogReads: 4 }],
    })

    // A wide flush window: the QueryFinish shows a few log reads late.
    const result = await runOnce(server, { c1: { status: 'pending', submittedAt } }, { outcomeRecheckIntervalMs: 100 })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: firstId, writtenRows: 42 })
  })

  test('an older release\'s shared-id replay that stops with no QueryFinish ends the run unknown', async () => {
    const submittedAt = new Date(Date.now() - 60_000).toISOString()
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: firstId, outcome: 'started', running: 1 }],
    })

    await expect(runOnce(server, { c1: { status: 'running', queryId: firstId, submittedAt } }, { maxPollErrors: 3 }))
      .rejects.toThrow(unknownError(firstId, SHARED_ID))
    expect(server.submits).toEqual([])
    expect(server.persisted.at(-1)?.c1).toMatchObject({ status: 'running', queryId: firstId })
  })

  test('an older release\'s replay that committed in the flush gap is not taken for the earlier failure', async () => {
    // An older release reset c1 (submittedAt = now - 60 s) and submitted the
    // replay under the shared id; the run died and this release resumes
    // before the replay's QueryFinish is in query_log.
    const submittedAt = new Date(Date.now() - 60_000).toISOString()
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: firstId, outcome: 'finished', hiddenLogReads: 1 }],
    })

    for (const resumeFrom of [
      { c1: { status: 'pending' as const, submittedAt } },
      { c1: { status: 'running' as const, queryId: firstId, submittedAt } },
    ]) {
      const result = await runOnce(server, resumeFrom)
      expect(result.progress.c1).toMatchObject({ status: 'done', queryId: firstId })
    }
    expect(server.submits).toEqual([])
  })

  test('an older release\'s replay that committed is done even when that client\'s clock ran ahead', async () => {
    // The older release stamped submittedAt from a client clock 3 minutes
    // ahead, so the replay's QueryFinish started before that bound.
    const submittedAt = new Date(Date.now() + 2 * 60_000).toISOString()
    const server = createSimulatedServer({ attempts: [killedFirst, { queryId: firstId, outcome: 'finished' }] })

    const result = await runOnce(server, { c1: { status: 'pending', submittedAt } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: firstId })
  })

  test('a replay an older release left running under the shared id is still polled to its outcome', async () => {
    const submittedAt = new Date(Date.now() - 60_000).toISOString()
    const server = createSimulatedServer({
      attempts: [
        { ...killedFirst, startMs: Date.now() - 120_000 },
        { queryId: firstId, outcome: 'finished', running: 2 },
      ],
    })

    const result = await runOnce(server, { c1: { status: 'running', queryId: firstId, submittedAt } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: firstId })
  })

  test('a resume whose replica probe fails submits nothing', async () => {
    const server = createSimulatedServer({ attempts: [killedFirst], nextOutcomes: ['finished'] })
    const query = server.executor.query.bind(server.executor)
    server.executor.query = async <T>(sql: string, settings?: Record<string, unknown>): Promise<T[]> => {
      if (sql.includes('system.one')) throw new Error('Code: 210. NETWORK_ERROR')
      return query<T>(sql, settings)
    }

    await expect(
      runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } }),
    ).rejects.toThrow('could not check which chunks are still running on the server (Code: 210. NETWORK_ERROR)')
    expect(server.submits).toEqual([])
  })

  // Finding 4 / round-2 item 4: a user denied clusterAllReplicas reads one
  // replica. A run or a QueryFinish it finds there holds; anything else,
  // a failure row included, may differ on another replica.
  test('a resume whose replica probe is denied trusts only a run or a QueryFinish it finds', async () => {
    const denied = 'Code: 497. DB::Exception: default: Not enough privileges. (ACCESS_DENIED)'
    const deniedReason = `the user may not read every replica (${denied}), and the replica it can read shows neither a run of it nor a QueryFinish`
    const deny = (server: ReturnType<typeof createSimulatedServer>) => {
      const query = server.executor.query.bind(server.executor)
      server.executor.query = async <T>(sql: string, settings?: Record<string, unknown>): Promise<T[]> => {
        if (sql.includes('system.one')) throw Object.assign(new Error(denied), { code: '497' })
        return query<T>(sql, settings)
      }
    }
    const recorded = { c1: { status: 'pending' as const, queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } }

    const absent = createSimulatedServer({ attempts: [killedFirst], nextOutcomes: ['finished'] })
    deny(absent)
    await expect(runOnce(absent, recorded)).rejects.toThrow(unknownError(recordedReplayId, deniedReason))
    expect(absent.submits).toEqual([])

    const failedLocally = createSimulatedServer({ attempts: [{ queryId: recordedReplayId, outcome: 'failed' }], nextOutcomes: ['finished'] })
    deny(failedLocally)
    await expect(runOnce(failedLocally, { c1: { ...recorded.c1, status: 'submitted' } }, { replayFailed: true }))
      .rejects.toThrow(unknownError(recordedReplayId, deniedReason))
    expect(failedLocally.submits).toEqual([])

    // A failure this release proved before the denial stays proven.
    const proven = createSimulatedServer({ attempts: [{ queryId: recordedReplayId, outcome: 'failed' }], nextOutcomes: ['finished'] })
    deny(proven)
    const replayed = await runOnce(proven, { c1: { ...recorded.c1, status: 'failed' } }, { replayFailed: true })
    expect(proven.submits).toHaveLength(1)
    expect(replayed.progress.c1).toMatchObject({ status: 'done', queryId: proven.submits[0] })

    const found = createSimulatedServer({ attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'finished' }] })
    deny(found)
    const result = await runOnce(found, recorded)
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: recordedReplayId })
    expect(found.submits).toEqual([])
  })

  // Round-2 item 8: with clickhouse.cluster set and the cluster denied, the
  // reads use the local tables, as chkit-py does.
  test('a denied explicit cluster reads the local tables, the polls too', async () => {
    const denied = 'Code: 497. DB::Exception: default: Not enough privileges. (ACCESS_DENIED)'
    const reads: string[] = []
    const server = createSimulatedServer({ attempts: [{ queryId: recordedReplayId, outcome: 'started' }], nextOutcomes: ['finished'] })
    server.executor.systemTableSource = (table) => `clusterAllReplicas('default', system.${table})`
    const query = server.executor.query.bind(server.executor)
    server.executor.query = async <T>(sql: string, settings?: Record<string, unknown>): Promise<T[]> => {
      if (sql.includes('clusterAllReplicas')) throw Object.assign(new Error(denied), { code: '497' })
      if (sql.includes('system.processes') || sql.includes('system.query_log')) reads.push(sql)
      return query<T>(sql, settings)
    }
    const recorded = { c1: { status: 'pending' as const, queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } }

    await expect(executeBackfill({
      executor: server.executor,
      cluster: 'default',
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 1,
      outcomeRecheckAttempts: 2,
      outcomeRecheckIntervalMs: 1,
      resumeFrom: recorded,
      checkpointVersion: CHECKPOINT_VERSION,
      onProgress: (progress) => { server.persisted.push(progress) },
    })).rejects.toThrow(`chunk c1 (query_id ${recordedReplayId}): the user may not read every replica (${denied})`)
    expect(server.submits).toEqual([])

    const accepted = await executeBackfill({
      executor: server.executor,
      cluster: 'default',
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 1,
      outcomeRecheckAttempts: 2,
      outcomeRecheckIntervalMs: 1,
      resumeFrom: recorded,
      checkpointVersion: CHECKPOINT_VERSION,
      acceptUnknown: true,
      onProgress: (progress) => { server.persisted.push(progress) },
    })
    expect(server.submits).toHaveLength(1)
    expect(accepted.progress.c1?.status).toBe('done')
    expect(reads.length).toBeGreaterThan(4)
    for (const sql of reads) expect(sql).toMatch(/FROM system\.(processes|query_log)/)
  })

  // Round-2 item 1: SIGINT and SIGTERM abort the run's signal.
  test('an aborted run submits no new chunk and reports nothing after it rejects', async () => {
    const controller = new AbortController()
    const submits: string[] = []
    let release: () => void = () => undefined
    const executor = createMockExecutor(new Map([[`backfill-${PLAN_ID}-c1`, [{ status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]]]))
    executor.submit = (_sql, queryId, _settings, admission) => {
      // The request is created, then the run is interrupted.
      if (admission && !admission.admit()) return Promise.reject(sendNotAdmittedError())
      admission?.handedOff?.()
      submits.push(queryId ?? '')
      controller.abort()
      return new Promise((resolve) => { release = () => resolve(queryId ?? '') })
    }
    const reports: BackfillProgress[] = []

    await expect(executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }, { id: 'c2' }],
      buildQuery: () => 'SELECT 1',
      concurrency: 1,
      pollIntervalMs: 1,
      signal: controller.signal,
      onProgress: (progress) => { reports.push(progress) },
    })).rejects.toThrow(`Backfill plan ${PLAN_ID}: interrupted. No new chunk was submitted`)
    const reported = reports.length
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(submits).toEqual([`backfill-${PLAN_ID}-c1`])
    expect(reports).toHaveLength(reported)
    expect(reports.at(-1)?.c1).toEqual({ status: 'pending', queryId: `backfill-${PLAN_ID}-c1`, singleSend: true })
  })

  // Round 3 item 1: before this release a resume could send the chunk's id a
  // second time, so a failure row of an older release's attempt may belong
  // to a send whose QueryFinish is still on its way.
  test('a failure row of an attempt an older release recorded is unknown, not a failure', async () => {
    for (const resumeFrom of [{}, { c1: { status: 'pending' as const } }, { c1: { status: 'failed' as const, queryId: firstId } }]) {
      const server = createSimulatedServer({ attempts: [killedFirst], nextOutcomes: ['finished'] })
      await expect(runOnce(server, resumeFrom, { replayFailed: true, checkpointVersion: undefined })).rejects.toThrow(
        unknownError(firstId, 'an older release may have sent it more than once under this query id, so the failure in system.query_log may not be its last send'),
      )
      expect(server.submits).toEqual([])
    }

    // The second send's QueryFinish arrives: done, with no flag.
    const late = createSimulatedServer({ attempts: [killedFirst, { queryId: firstId, outcome: 'finished', hiddenLogReads: 2 }] })
    const result = await runOnce(late, { c1: { status: 'pending' } }, { replayFailed: true, checkpointVersion: undefined })
    expect(late.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: firstId })
  })

  // Round 3 item 2: two replicas, one unavailable. A probe that skipped it
  // would count one host and read one replica's log as the whole truth.
  test('a resume whose strict probe meets an unavailable replica submits nothing', async () => {
    const server = createSimulatedServer({ attempts: [{ queryId: recordedReplayId, outcome: 'failed' }], nextOutcomes: ['finished'] })
    const query = server.executor.query.bind(server.executor)
    server.executor.query = async <T>(sql: string, settings?: Record<string, unknown>): Promise<T[]> => {
      if (sql.includes('system.one')) {
        if (sql.includes('skip_unavailable_shards = 0')) throw new Error('Code: 279. DB::NetException: All connection tries failed. (ALL_CONNECTION_TRIES_FAILED)')
        return [{ replicas: '1' }] as T[]
      }
      return query<T>(sql, settings)
    }

    await expect(
      runOnce(server, { c1: { status: 'failed', queryId: recordedReplayId, submittedAt: hourAgo(), singleSend: true } }, { replayFailed: true }),
    ).rejects.toThrow('could not check which chunks are still running on the server (Code: 279.')
    expect(server.submits).toEqual([])
  })

  // Round 3 item 3: chunk B waits on its pre-send checkpoint while chunk A's
  // outcome turns out unknown. B must not be sent, and keeps its state.
  test('a chunk whose pre-send checkpoint finishes after the dispatch stopped is not sent', async () => {
    const submits: string[] = []
    const executor = createMockExecutor(new Map<string, QueryStatus[]>([
      [`backfill-${PLAN_ID}-c1`, [{ status: 'failed', error: 'late block', durationMs: 1 }]],
    ]))
    // A failed after writing rows: unknown at once.
    const query = executor.query.bind(executor)
    executor.query = async <T>(sql: string): Promise<T[]> => {
      const rows = await query<T>(sql)
      return rows.map((row) => ('type' in (row as object) ? { ...(row as object), written_rows: '7' } : row)) as T[]
    }
    executor.submit = async (_sql, queryId) => {
      submits.push(queryId ?? '')
      return queryId ?? ''
    }
    const saved: BackfillProgress[] = []
    let held = false

    await expect(executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }, { id: 'c2' }],
      buildQuery: () => 'SELECT 1',
      concurrency: 2,
      pollIntervalMs: 1,
      onProgress: async (progress) => {
        saved.push(progress)
        // Hold B's pre-send write while A's polls classify A.
        if (progress.c2?.queryId !== undefined && !held) {
          held = true
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      },
    })).rejects.toThrow(`chunk c1 (query_id backfill-${PLAN_ID}-c1): it failed after writing 7 rows`)

    expect(held).toBe(true)
    expect(submits).toEqual([`backfill-${PLAN_ID}-c1`])
    expect(saved.at(-1)?.c2).toEqual({ status: 'pending' })
  })

  // Round 3 item 3: the interrupt lands while a chunk's SQL is being built.
  test('a chunk interrupted while its SQL is built is not sent', async () => {
    const controller = new AbortController()
    const submits: string[] = []
    const executor = createMockExecutor(new Map())
    executor.submit = async (_sql, queryId) => {
      submits.push(queryId ?? '')
      return queryId ?? ''
    }

    await expect(executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => {
        controller.abort()
        return 'SELECT 1'
      },
      pollIntervalMs: 1,
      signal: controller.signal,
    })).rejects.toThrow(`Backfill plan ${PLAN_ID}: interrupted.`)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(submits).toEqual([])
  })

  // Round 3 item 8: a replay gets its id when it is sent, so a proved failure
  // the run never reaches keeps its evidence.
  test('a replay the run never reaches keeps its failed state and query id', async () => {
    const executor = createMockExecutor(new Map<string, QueryStatus[]>([
      [`backfill-${PLAN_ID}-c1`, [{ status: 'failed', error: 'OOM', durationMs: 1 }]],
      [`backfill-${PLAN_ID}-c2`, [{ status: 'failed', error: 'OOM', durationMs: 1 }]],
    ]))
    executor.submit = async () => {
      throw new Error('Code: 241. MEMORY_LIMIT_EXCEEDED')
    }
    const saved: BackfillProgress[] = []
    const c2 = { status: 'failed' as const, queryId: `backfill-${PLAN_ID}-c2`, singleSend: true }

    await expect(executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }, { id: 'c2' }],
      buildQuery: () => 'SELECT 1',
      concurrency: 1,
      pollIntervalMs: 1,
      resumeFrom: { c1: { status: 'failed', queryId: `backfill-${PLAN_ID}-c1`, singleSend: true }, c2 },
      checkpointVersion: CHECKPOINT_VERSION,
      replayFailed: true,
      onProgress: (progress) => { saved.push(progress) },
    })).rejects.toThrow('MEMORY_LIMIT_EXCEEDED')

    expect(saved.at(-1)?.c2).toMatchObject(c2)
    expect(saved.at(-1)?.c1?.queryId?.startsWith(`backfill-${PLAN_ID}-c1-`)).toBe(true)
  })

  // Round 3 item 9: a read that hangs before the dispatch does not keep an
  // interrupted resume waiting.
  test('an abort during a hung resume read rejects at once', async () => {
    const controller = new AbortController()
    const executor = createMockExecutor(new Map())
    executor.query = () => new Promise(() => undefined)

    const run = executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => 'SELECT 1',
      resumeFrom: { c1: { status: 'pending', queryId: firstId, singleSend: true } },
      checkpointVersion: CHECKPOINT_VERSION,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 20)

    await expect(run).rejects.toThrow(`Backfill plan ${PLAN_ID}: interrupted.`)
  })

  // Round 5 item 5: a version-2 writer saved each id before its submit, so
  // its pending chunk without one was never sent; only singleSend is dropped.
  test('a version-2 checkpoint keeps its never-sent chunks and drops singleSend', async () => {
    const server = createSimulatedServer({ attempts: [killedFirst], nextOutcomes: ['finished'] })
    await expect(runOnce(server, { c1: { status: 'failed', queryId: firstId, singleSend: true } }, { replayFailed: true, checkpointVersion: 2 }))
      .rejects.toThrow(unknownError(firstId, 'an older release may have sent it more than once under this query id, so the failure in system.query_log may not be its last send'))
    expect(server.submits).toEqual([])

    const fresh = createSimulatedServer({ nextOutcomes: ['finished'] })
    const result = await runOnce(fresh, { c1: { status: 'pending' } }, { checkpointVersion: 2 })
    expect(fresh.submits).toEqual([firstId])
    expect(result.progress.c1?.status).toBe('done')
  })

  // Round 4 item 3: the checkpoint a rollback to an older release rewrites
  // without a version keeps this release's singleSend markers; that release
  // may have resent the ids, so the markers prove nothing (shared fixture).
  test('a rolled-back checkpoint\'s singleSend markers prove nothing', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../test/fixtures/backfill-rollback-checkpoint.json', import.meta.url), 'utf8')) as { progress: BackfillProgress }
    const failedBeforeStart: QueryStatus[] = [{ status: 'failed', error: 'Code: 394. QUERY_WAS_CANCELLED', durationMs: 1 }]
    const submits: string[] = []
    const executor = createMockExecutor(new Map([
      [`backfill-${PLAN_ID}-c1`, failedBeforeStart],
      [`backfill-${PLAN_ID}-c2`, failedBeforeStart],
      [`backfill-${PLAN_ID}-c1-*`, [{ status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]],
      [`backfill-${PLAN_ID}-c2-*`, [{ status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]],
    ]))
    const submit = executor.submit.bind(executor)
    executor.submit = (sql, queryId, settings, admission) => {
      submits.push(queryId ?? '')
      return submit(sql, queryId, settings, admission)
    }
    const resume = (extra: { replayFailed?: boolean; acceptUnknown?: boolean }) => executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }, { id: 'c2' }],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 1,
      outcomeRecheckAttempts: 2,
      outcomeRecheckIntervalMs: 1,
      resumeFrom: fixture.progress,
      ...extra,
    })
    const resent = 'an older release may have sent it more than once under this query id, so the failure in system.query_log may not be its last send'

    await expect(resume({ replayFailed: true })).rejects.toThrow(
      `chunk c1 (query_id backfill-${PLAN_ID}-c1): ${resent}; chunk c2 (query_id backfill-${PLAN_ID}-c2): ${resent}.`,
    )
    expect(submits).toEqual([])

    const accepted = await resume({ acceptUnknown: true })
    expect(submits).toHaveLength(2)
    expect(accepted.completed).toBe(2)
  })

  // Round 4 item 2: an executor that does not say it sends once records no
  // singleSend, so a failure of its attempt is never proof.
  test('an attempt of an executor that may resend is never proved failed', async () => {
    const executor = createMockExecutor(new Map([[`backfill-${PLAN_ID}-c1`, [{ status: 'failed', error: 'OOM', durationMs: 1 }]]]))
    const generic: ClickHouseExecutor = { ...executor, submitSendsOnce: undefined }
    const saved: BackfillProgress[] = []

    await expect(executeBackfill({
      executor: generic,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 1,
      maxPollErrors: 2,
      outcomeRecheckAttempts: 1,
      outcomeRecheckIntervalMs: 1,
      onProgress: (progress) => { saved.push(progress) },
    })).rejects.toThrow(`chunk c1 (query_id backfill-${PLAN_ID}-c1): an older release may have sent it more than once`)
    expect(saved.some((progress) => progress.c1?.singleSend !== undefined)).toBe(false)
  })
})

// Round 4 items 1 and 4, through the real executor and its driver: a stand-in
// for ClickHouse's HTTP interface records every request.
describe('executeBackfill interrupted around the send (#765, round 4)', () => {
  let server: http.Server
  const received: string[] = []
  let url = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      received.push(new URL(req.url ?? '/', 'http://localhost').searchParams.get('query_id') ?? '')
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'X-ClickHouse-Summary': '{}' })
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const previous = { status: 'failed' as const, queryId: `backfill-${PLAN_ID}-c1`, singleSend: true }

  async function interruptedReplay(interrupt: (controller: AbortController, executor: ClickHouseExecutor) => { buildQuery: () => string }) {
    const executor = createStatelessClickHouseExecutor({ url, username: 'default', password: '', database: 'default' })
    // The resume's reads find the chunk's proved failure.
    const query = executor.query.bind(executor)
    executor.query = async <T>(sql: string, settings?: Record<string, unknown>): Promise<T[]> => {
      if (sql.includes('now64')) return [{ now_ms: String(Date.now()) }] as T[]
      if (sql.includes('system.one')) return [{ replicas: '1' }] as T[]
      if (sql.includes('system.processes')) return [] as T[]
      if (sql.includes('system.query_log')) {
        return [{ query_id: previous.queryId, type: 'ExceptionBeforeStart', written_rows: '0', written_bytes: '0', query_duration_ms: '0', exception: 'OOM' }] as T[]
      }
      return query<T>(sql, settings)
    }
    const controller = new AbortController()
    const { buildQuery } = interrupt(controller, executor)
    const reports: BackfillProgress[] = []
    const before = received.length

    await expect(executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery,
      pollIntervalMs: 1,
      resumeFrom: { c1: previous },
      checkpointVersion: CHECKPOINT_VERSION,
      replayFailed: true,
      signal: controller.signal,
      onProgress: (progress) => { reports.push(progress) },
    })).rejects.toThrow(`Backfill plan ${PLAN_ID}: interrupted.`)
    const reported = reports.length
    await new Promise((resolve) => setTimeout(resolve, 100))
    await executor.close()

    // Nothing reached the server, nothing was saved after the interrupt
    // returned, and the proved failure was saved back before it did.
    expect(received.slice(before).filter((id) => id.startsWith(`backfill-${PLAN_ID}-c1-`))).toEqual([])
    expect(reports).toHaveLength(reported)
    expect(reports.at(-1)?.c1).toMatchObject(previous)
  }

  test('an interrupt in the driver\'s yield before the request is created sends nothing', async () => {
    await interruptedReplay((controller, executor) => {
      const submit = executor.submit.bind(executor)
      executor.submit = (sql, queryId, settings, admission) => {
        const sending = submit(sql, queryId, settings, admission)
        controller.abort()
        return sending
      }
      return { buildQuery: () => 'INSERT INTO t SELECT 1' }
    })
  })

  test('an interrupt queued while the SQL is built sends nothing', async () => {
    await interruptedReplay((controller) => ({
      buildQuery: () => {
        queueMicrotask(() => controller.abort())
        return 'INSERT INTO t SELECT 1'
      },
    }))
  })

  // Round 5 item 4: an executor that cannot refuse a send as its request is
  // created could send after the interrupt returned.
  test('an interruptible run refuses an executor without submitSendsOnce', async () => {
    const generic: ClickHouseExecutor = { ...createMockExecutor(new Map()), submitSendsOnce: undefined }

    await expect(executeBackfill({
      executor: generic,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => 'SELECT 1',
      signal: new AbortController().signal,
    })).rejects.toThrow('An interruptible backfill needs an executor with submitSendsOnce')
  })

  // Whole-branch review: a failure proves a safe replay only with an explicit
  // zero for its written rows, and none seen written before.
  for (const [writtenRows, seen, reason] of [
    [null, undefined, 'system.query_log does not say how many rows it wrote'],
    ['', undefined, 'system.query_log does not say how many rows it wrote'],
    ['0', 37, 'it failed after writing 37 rows, which a replay would write again'],
  ] as const) {
    test(`a failure with written_rows ${JSON.stringify(writtenRows)} after ${seen ?? 'no'} rows seen is unknown`, async () => {
      const submits: string[] = []
      const executor = createMockExecutor(new Map())
      executor.query = async <T>(sql: string): Promise<T[]> => {
        if (sql.includes('system.one')) return [{ replicas: '1' }] as T[]
        if (sql.includes('system.query_log')) {
          return [{ query_id: `backfill-${PLAN_ID}-c1`, type: 'ExceptionWhileProcessing', written_rows: writtenRows, written_bytes: '0', query_duration_ms: '1', exception: 'late block' }] as T[]
        }
        return [] as T[]
      }
      executor.submit = async (_sql, queryId) => {
        submits.push(queryId ?? '')
        return queryId ?? ''
      }

      await expect(executeBackfill({
        executor,
        planId: PLAN_ID,
        chunks: [{ id: 'c1' }],
        buildQuery: () => 'SELECT 1',
        // In flight when the run stopped: its failure is proven here or never.
        resumeFrom: { c1: { status: 'submitted', queryId: `backfill-${PLAN_ID}-c1`, singleSend: true, ...(seen === undefined ? {} : { writtenRows: seen }) } },
        checkpointVersion: CHECKPOINT_VERSION,
        replayFailed: true,
        outcomeRecheckAttempts: 1,
        outcomeRecheckIntervalMs: 1,
      })).rejects.toThrow(`chunk c1 (query_id backfill-${PLAN_ID}-c1): ${reason}.`)
      expect(submits).toEqual([])
    })
  }
})


// Opus critic, item 2: a failure this release proved is not proven again. Its
// query_log rows may have aged out, or sit on a replica the resume cannot read.
describe('a resume after a proven failure whose query_log rows are gone', () => {
  const failure = { status: 'failed' as const, queryId: `backfill-${PLAN_ID}-c1`, error: 'Code: 241 MEMORY_LIMIT_EXCEEDED' }

  async function resume(c1: BackfillProgress[string], flags: { replayFailed?: boolean } = {}) {
    // query_log has nothing for c1; every attempt sent finishes.
    const statuses = new Map<string, QueryStatus[]>()
    const executor = createMockExecutor(statuses)
    const submits: string[] = []
    const submit = executor.submit.bind(executor)
    executor.submit = (sql, queryId, settings, admission) => {
      submits.push(queryId ?? '')
      statuses.set(queryId ?? '', [{ status: 'finished', writtenRows: 1 }])
      return submit(sql, queryId, settings, admission)
    }
    const result = await executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }, { id: 'c2' }],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 1,
      outcomeRecheckAttempts: 1,
      outcomeRecheckIntervalMs: 1,
      resumeFrom: { c1, c2: { status: 'pending' } },
      checkpointVersion: CHECKPOINT_VERSION,
      ...flags,
    })
    return { result, submits }
  }

  test('a plain resume skips it and runs the pending chunks', async () => {
    const { result, submits } = await resume({ ...failure, singleSend: true })

    expect(submits).toEqual([`backfill-${PLAN_ID}-c2`])
    expect(result.progress.c1).toEqual({ ...failure, singleSend: true })
    expect(result.progress.c2).toMatchObject({ status: 'done' })
    expect(result).toMatchObject({ total: 2, completed: 1, failed: 1 })
  })

  test('--replay-failed replays it under a new id', async () => {
    const { result, submits } = await resume({ ...failure, singleSend: true }, { replayFailed: true })

    expect(submits.sort()).toEqual([`backfill-${PLAN_ID}-c2`, expect.stringMatching(new RegExp(`^backfill-${PLAN_ID}-c1-`))].sort())
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: submits.find((id) => id.startsWith(`backfill-${PLAN_ID}-c1-`)) })
  })

  test('a failure an older release recorded still needs proof, and stops the resume', async () => {
    for (const flags of [{}, { replayFailed: true }]) {
      const run = resume(failure, flags)

      await expect(run).rejects.toThrow(`chunk c1 (query_id backfill-${PLAN_ID}-c1): it is not running on any replica and system.query_log has no outcome for it.`)
    }
  })
})

// Opus critic, item 1: an interrupt never waits without end for a request
// that was admitted and never started.
describe('an interrupt while an admitted send never hands off', () => {
  async function stalledRun(executor: ClickHouseExecutor, handoffTimeoutMs: number) {
    const controller = new AbortController()
    const reports: BackfillProgress[] = []
    const run = executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => 'INSERT INTO t SELECT 1',
      pollIntervalMs: 1,
      signal: controller.signal,
      handoffTimeoutMs,
      onProgress: (progress) => { reports.push(progress) },
    })
    return { controller, reports, run }
  }

  test('a server that never answers the TLS handshake: the send is abandoned and its attempt may have run', async () => {
    const connections: Socket[] = []
    const closed: Socket[] = []
    const server = createServer((socket) => {
      connections.push(socket)
      socket.on('data', () => undefined)
      socket.on('close', () => closed.push(socket))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const executor = createStatelessClickHouseExecutor(
      { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, username: 'default', password: '', database: 'default' },
      { sendConnectTimeoutMs: 600_000 },
    )
    const { controller, reports, run } = await stalledRun(executor, 300)
    while (connections.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    const started = Date.now()

    controller.abort()
    const error = await run.then(() => undefined, (rejection: unknown) => rejection)
    const elapsed = Date.now() - started
    // The socket chkit opened is gone: nothing of the request is written later.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const closedByClient = closed.length
    for (const socket of connections) socket.destroy()
    server.close()
    void executor.close().catch(() => undefined)

    expect(error).toBeInstanceOf(BackfillInterruptedError)
    expect(error).toMatchObject({ keepLock: false, note: 'The send of chunk c1 did not reach the server in time and was abandoned: it may still have reached it, so its attempt stays recorded as one that may have run. Unless system.query_log shows its outcome, a resume stops on it, and only --accept-unknown replays it.' })
    expect(elapsed).toBeLessThan(2_000)
    expect(closedByClient).toBe(connections.length)
    expect(reports.at(-1)?.c1).toEqual({ status: 'pending', queryId: `backfill-${PLAN_ID}-c1`, singleSend: true })
  })

  test('a send stuck before it reaches the transport keeps the lock', async () => {
    const executor = createMockExecutor(new Map())
    let sending = false
    // Admitted by the run, then stuck before its request reaches the
    // transport (nothing there to abandon).
    executor.submit = () => {
      sending = true
      return new Promise<string>(() => undefined)
    }
    const { controller, run } = await stalledRun(executor, 100)
    while (!sending) await new Promise((resolve) => setTimeout(resolve, 5))

    controller.abort()
    const error = await run.then(() => undefined, (rejection: unknown) => rejection)

    expect(error).toBeInstanceOf(BackfillInterruptedError)
    expect(error).toMatchObject({ keepLock: true })
    expect((error as Error).message).toContain('The send of chunk c1 did not reach the server in time and could not be stopped (chunk c1): it may still be sent while this process runs, so its attempt stays recorded as one that may have run and the plan\'s lock stays in place.')
  })
})

// Opus critic, parallel_distributed_insert_select: with no failure provable
// for the target, a zero-row failure is unknown and nothing is replayed.
test('a zero-row failure of a target whose failures cannot be proven is unknown', async () => {
  const reason = 'its target app.events is a Distributed table, whose shards can write the rows of an INSERT SELECT without system.query_log counting them in its written_rows'
  const submits: string[] = []
  const executor = createMockExecutor(new Map([[`backfill-${PLAN_ID}-c1`, [{ status: 'failed', error: 'shard failed' }]]]))
  const submit = executor.submit.bind(executor)
  executor.submit = (sql, queryId, settings, admission) => {
    submits.push(queryId ?? '')
    return submit(sql, queryId, settings, admission)
  }
  const run = (resumeFrom: BackfillProgress | undefined, replayFailed?: boolean) => executeBackfill({
    executor,
    planId: PLAN_ID,
    chunks: [{ id: 'c1' }],
    buildQuery: () => 'INSERT INTO app.events SELECT 1',
    pollIntervalMs: 1,
    outcomeRecheckAttempts: 1,
    outcomeRecheckIntervalMs: 1,
    resumeFrom,
    checkpointVersion: CHECKPOINT_VERSION,
    replayFailed,
    unprovableFailures: reason,
  })

  // A run that sees the failure stops instead of recording it failed.
  await expect(run(undefined)).rejects.toThrow(`chunk c1 (query_id backfill-${PLAN_ID}-c1): ${reason}.`)
  expect(submits).toEqual([`backfill-${PLAN_ID}-c1`])
  // A resume with --replay-failed replays nothing.
  await expect(run({ c1: { status: 'submitted', queryId: `backfill-${PLAN_ID}-c1`, singleSend: true } }, true))
    .rejects.toThrow(`chunk c1 (query_id backfill-${PLAN_ID}-c1): ${reason}.`)
  expect(submits).toHaveLength(1)
})

// Coordinator follow-up: the interrupt never waits without end behind a
// checkpoint write. A write under way ends within the interrupt's bounded
// wait, or the lock stays; no write starts after the interrupt returns.
describe('an interrupt while a checkpoint write is under way', () => {
  const HUNG = 'The checkpoint write under way did not finish in time: it may still complete while this process runs, so the plan\'s lock stays in place.'

  async function interruptDuringWrite(writeMs: number | undefined) {
    const controller = new AbortController()
    const writes: string[] = []
    let writing = false
    const run = executeBackfill({
      executor: createMockExecutor(new Map([[`backfill-${PLAN_ID}-c1`, [{ status: 'running' }]]])),
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => 'INSERT INTO t SELECT 1',
      pollIntervalMs: 1,
      signal: controller.signal,
      handoffTimeoutMs: 300,
      onProgress: (progress) => {
        writes.push(progress.c1?.status ?? '')
        if (progress.c1?.status !== 'submitted') return
        writing = true
        // The write that records the chunk submitted is slow, or hangs.
        return new Promise<void>((resolve) => {
          if (writeMs !== undefined) setTimeout(resolve, writeMs)
        })
      },
    })
    while (!writing) await new Promise((resolve) => setTimeout(resolve, 5))
    const started = Date.now()
    controller.abort()
    const error = await run.then(() => undefined, (rejection: unknown) => rejection)
    const elapsed = Date.now() - started
    const written = writes.length
    await new Promise((resolve) => setTimeout(resolve, 100))
    return { error, elapsed, written, writes }
  }

  test('a hung write: the interrupt returns after its bounded wait and keeps the lock', async () => {
    const { error, elapsed, written, writes } = await interruptDuringWrite(undefined)

    expect(error).toBeInstanceOf(BackfillInterruptedError)
    expect(error).toMatchObject({ keepLock: true, note: HUNG })
    expect(elapsed).toBeLessThan(2_000)
    expect(writes).toHaveLength(written)
  })

  test('a slow write that ends in time: the interrupt waits for it and releases the lock', async () => {
    const { error, elapsed, written, writes } = await interruptDuringWrite(100)

    expect(error).toBeInstanceOf(BackfillInterruptedError)
    expect(error).toMatchObject({ keepLock: false })
    expect(elapsed).toBeGreaterThanOrEqual(80)
    // No write starts after the interrupt returned.
    expect(writes).toHaveLength(written)
  })
})

// Opus re-review: with parallel replicas, the initiator's failure row says
// written_rows = 0 while its secondary queries committed rows, and a
// replica's query_log can flush them late. Any secondary query seen for an
// attempt makes its failure unknown, whatever its written rows say.
describe('a failure whose attempt ran secondary queries', () => {
  const id = `backfill-${PLAN_ID}-c1`
  const failure = { query_id: id, is_initial_query: 1, type: 'ExceptionWhileProcessing', written_rows: '0', written_bytes: '0', query_duration_ms: '1', exception: 'transient' }
  const secondary = (type: string, written: string | null, queryId = 'secondary-1') =>
    ({ query_id: queryId, initial_query_id: id, is_initial_query: 0, type, written_rows: written, written_bytes: '0', query_duration_ms: '1', exception: '' })
  const SECONDARY = `chunk c1 (query_id ${id}): it ran a secondary query on another replica or shard (query_id secondary-1), whose writes system.query_log may show late or not at all, so its failure proves nothing.`

  async function resume(log: object[], running: object[] = []) {
    const submits: string[] = []
    const executor = createMockExecutor(new Map())
    executor.query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('now64')) return [{ now_ms: String(Date.now()) }] as T[]
      if (sql.includes('system.one')) return [{ replicas: '1' }] as T[]
      if (sql.includes('system.processes')) {
        expect(sql).toMatch(/initial_user = currentUser\(\) AND initial_query_id (IN|LIKE) .* AND is_initial_query = 0/)
        return running as T[]
      }
      if (sql.includes('system.query_log')) return [failure, ...log] as T[]
      return [] as T[]
    }
    executor.submit = async (_sql, queryId) => {
      submits.push(queryId ?? '')
      return queryId ?? ''
    }
    const run = executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [{ id: 'c1' }],
      buildQuery: () => 'INSERT INTO t SELECT 1',
      resumeFrom: { c1: { status: 'submitted', queryId: id, singleSend: true } },
      checkpointVersion: CHECKPOINT_VERSION,
      replayFailed: true,
      pollIntervalMs: 1,
      outcomeRecheckAttempts: 1,
      outcomeRecheckIntervalMs: 1,
    }).then(() => undefined, (error: unknown) => error as Error)
    return { error: await run, submits }
  }

  for (const [label, log, running] of [
    ['wrote rows', [secondary('ExceptionWhileProcessing', '581632')], []],
    ['ended with zero rows', [secondary('QueryStart', '0'), secondary('ExceptionWhileProcessing', '0')], []],
    ['only started', [secondary('QueryStart', '0')], []],
    ['has no row count', [secondary('QueryFinish', null)], []],
    ['is still running', [], [{ query_id: 'secondary-1', initial_query_id: id, is_initial_query: 0, read_rows: '0', read_bytes: '0', written_rows: '0', written_bytes: '0', elapsed: 1 }]],
  ] as const) {
    test(`a secondary query that ${label} makes it unknown, and --replay-failed sends nothing`, async () => {
      const { error, submits } = await resume([...log], [...running])

      expect(error?.message).toContain(SECONDARY)
      expect(submits).toEqual([])
    })
  }

  test('without a secondary query, the failure read after the window is proof, and the chunk is replayed', async () => {
    const { error, submits } = await resume([])

    // The replay's own reads find nothing, so its outcome is unknown; it was sent once.
    expect(submits).toHaveLength(1)
    expect(submits[0]).toStartWith(`${id}-`)
    expect(error?.message).not.toContain('secondary')
  })
})
