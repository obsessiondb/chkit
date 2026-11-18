import { describe, expect, test } from 'bun:test'
import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'
import { executeBackfill, syncProgress, type BackfillProgress } from './async-backfill.js'

const PLAN_ID = 'test-plan'

/**
 * A scripted server: each query id walks through its list of statuses. A
 * `running` status is in system.processes and read by queryStatus, which
 * moves the id to its next status; a `finished` or `failed` one is a
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
      if (sql.includes('system.processes')) {
        return idsIn(sql).filter((id) => current(id).status === 'running').map((id) => ({ query_id: id })) as T[]
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
    async submit(_sql: string, queryId?: string): Promise<string> {
      return queryId ?? crypto.randomUUID()
    },
    async queryStatus(queryId: string): Promise<QueryStatus> {
      const qs = current(queryId)
      if (qs.status !== 'running') return { status: 'unknown' }
      cursors.set(queryId, (cursors.get(queryId) ?? 0) + 1)
      return qs
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
  // chunk is what --replay-failed runs again.
  test('a polling outage leaves the chunk unsettled and stops the run instead of recording it failed', async () => {
    const executor = createMockExecutor(new Map())
    executor.queryStatus = async (): Promise<QueryStatus> => {
      throw new Error('ETIMEDOUT')
    }
    const saved: BackfillProgress[] = []

    await expect(
      executeBackfill({
        executor,
        planId: PLAN_ID,
        chunks: [chunks[0]],
        buildQuery: () => 'SELECT 1',
        pollIntervalMs: 10,
        maxPollErrors: 3,
        onProgress: (progress) => { saved.push(progress) },
      }),
    ).rejects.toThrow(
      `Backfill plan ${PLAN_ID}: the outcome of the last attempt is unknown for chunk c1 (query_id backfill-${PLAN_ID}-c1): lost contact with the server after 3 consecutive poll errors (ETIMEDOUT). A chunk whose outcome is unknown is not submitted again, as it may have written its rows. Re-run the resume once system.query_log records the outcome, or pass --accept-unknown to replay it under a new query id, which can write its rows twice.`,
    )
    expect(saved.at(-1)?.c1).toEqual({ status: 'submitted', queryId: `backfill-${PLAN_ID}-c1` })
  })

  test('replayFailed replays a chunk the server shows failed under a new id', async () => {
    const queryId = `backfill-${PLAN_ID}-c1`
    const statuses = new Map<string, QueryStatus[]>([
      [queryId, [{ status: 'failed', error: 'OOM', durationMs: 5 }]],
      [`${queryId}-*`, [{ status: 'finished', writtenRows: 42, writtenBytes: 200, durationMs: 80 }]],
      [`backfill-${PLAN_ID}-c2`, [{ status: 'finished', writtenRows: 10, writtenBytes: 50, durationMs: 20 }]],
    ])

    const resumeFrom: BackfillProgress = {
      c1: { status: 'failed', queryId, error: 'OOM' },
      c2: { status: 'done', queryId: `backfill-${PLAN_ID}-c2`, writtenRows: 10 },
    }

    const result = await executeBackfill({
      executor: createMockExecutor(statuses),
      planId: PLAN_ID,
      chunks,
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      resumeFrom,
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
      expect(saved.at(-1)?.c1).toEqual({ status: 'pending', queryId: `backfill-${PLAN_ID}-c1` })
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

  test('updates failed server state for locally submitted chunk', async () => {
    const executor = createMockExecutor(new Map())
    executor.query = async <T>(sql: string): Promise<T[]> => {
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
      c1: { status: 'submitted', queryId: `backfill-${PLAN_ID}-c1` },
    }

    const synced = await syncProgress(executor, PLAN_ID, [{ id: 'c1' }], progress)
    expect(synced.c1.status).toBe('failed')
    expect(synced.c1.error).toBe('Memory limit exceeded')
  })

  test('uses systemTableSource when executor provides clustered tables', async () => {
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
    expect(processes).toContain("clusterAllReplicas('moebel_cluster', system.processes)")
    expect(queryLog).toContain("clusterAllReplicas('moebel_cluster', system.query_log)")
    expect(queries.join('\n')).not.toContain("clusterAllReplicas('cluster'")
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
// attempt the run submits is in system.processes for `runningReads` running
// reads of its id, then logged once `unflushedLogReads` more query_log reads
// have passed: the flush gap. An attempt that ended before the run starts is
// logged after `hiddenLogReads` query_log reads (Infinity: never, as with
// log_queries = 0 or a log that has not flushed). Earlier attempts' rows stay
// visible throughout. The time probe answers `clockOffsetMs` from the
// client's clock; the replica that runs a submitted attempt stamps it
// `submitClockOffsetMs` from it. A query_log read pruned by event_date hides
// the rows of attempts that started before that day.
type SimOutcome = 'finished' | 'failed' | 'started'

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
      : { ...base, type: 'ExceptionWhileProcessing', written_rows: '0', written_bytes: '0', query_duration_ms: '1', exception: 'Code: 394. QUERY_WAS_CANCELLED' }
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
  executor.submit = async (_sql, queryId) => {
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
  executor.queryStatus = async (queryId) => {
    const latest = attempts.filter((attempt) => attempt.queryId === queryId).at(-1)
    if (latest && isRunning(latest)) {
      latest.statusReads += 1
      return { status: 'running', readRows: 0, readBytes: 0, writtenRows: 0, writtenBytes: 0, elapsedMs: 0 }
    }
    return { status: 'unknown' }
  }
  executor.query = async <T>(sql: string): Promise<T[]> => {
    if (sql.includes('now64')) return [{ now_ms: String(serverNow()) }] as T[]
    if (sql.includes('system.processes')) {
      return attempts.filter((attempt) => isRunning(attempt) && matches(sql, attempt.queryId)).map((attempt) => ({ query_id: attempt.queryId })) as T[]
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
    extra: { replayFailed?: boolean; acceptUnknown?: boolean; maxPollErrors?: number } = {},
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
      onProgress: (progress) => {
        server.persisted.push(progress)
      },
      ...extra,
    })

  test('a replay started seconds after the failure ends done when its attempt finishes', async () => {
    const server = createSimulatedServer({ attempts: [killedFirst], nextOutcomes: ['finished'] })

    const result = await runOnce(
      server,
      { c1: { status: 'failed', queryId: firstId, error: 'Code: 394. QUERY_WAS_CANCELLED' } },
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

    const result = await runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo() } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: recordedReplayId, writtenRows: 42 })
  })

  test('a resume in the flush gap of a replay that failed records it failed without running it', async () => {
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'failed', hiddenLogReads: 1 }],
    })

    const result = await runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo() } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'failed', queryId: recordedReplayId })
  })

  // Finding 1: query_log can flush after the recheck window, or not at all,
  // so no row is no proof that a recorded attempt never ran.
  test('a recorded attempt with no row in query_log after the window stops the resume, and --accept-unknown replays it under a new id', async () => {
    for (const recorded of [
      { status: 'pending' as const, queryId: recordedReplayId, submittedAt: hourAgo() },
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

  test('a replay that started and has no outcome stops the resume before anything is submitted', async () => {
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'started' }],
      nextOutcomes: ['finished'],
    })

    for (const replayFailed of [false, true]) {
      await expect(
        runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo() } }, { replayFailed }),
      ).rejects.toThrow(unknownError(recordedReplayId, NO_OUTCOME))
    }
    expect(server.submits).toEqual([])
  })

  test('a run stopped between the replay submit and its state write attaches to it', async () => {
    const server = createSimulatedServer({
      attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'finished', running: 2 }],
    })

    const result = await runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo() } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: recordedReplayId })
  })

  test('a resume reads a finished replay by its own id, not the failed first attempt', async () => {
    const server = createSimulatedServer({ attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'finished' }] })

    const result = await runOnce(server, { c1: { status: 'running', queryId: recordedReplayId, submittedAt: hourAgo() } })

    expect(server.submits).toEqual([])
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: recordedReplayId, writtenRows: 42 })
  })

  test('a failed replay keeps its id on a plain resume and is replayed again under a third id', async () => {
    const server = createSimulatedServer({ attempts: [killedFirst], nextOutcomes: ['failed', 'finished'] })

    const first = await runOnce(server, { c1: { status: 'failed', queryId: firstId } }, { replayFailed: true })
    expect(first.progress.c1).toMatchObject({ status: 'failed', queryId: server.submits[0] })
    const plain = await runOnce(server, first.progress)
    expect(plain.progress.c1).toMatchObject({ status: 'failed', queryId: server.submits[0] })

    const second = await runOnce(server, plain.progress, { replayFailed: true })

    expect(server.submits).toHaveLength(2)
    expect(new Set([firstId, ...server.submits]).size).toBe(3)
    expect(second.progress.c1).toMatchObject({ status: 'done', queryId: server.submits[1] })
  })

  // Finding 3: a checkpoint can say failed without the server ever showing
  // it, as older releases recorded a polling outage.
  test('--replay-failed replays a chunk only on the server\'s evidence that it failed', async () => {
    const server = createSimulatedServer({
      attempts: [{ queryId: firstId, outcome: 'finished', hiddenLogReads: Number.POSITIVE_INFINITY }],
      nextOutcomes: ['finished'],
    })
    const lostContact = { status: 'failed' as const, queryId: firstId, error: 'Lost contact with query after 10 consecutive poll errors' }

    await expect(runOnce(server, { c1: lostContact }, { replayFailed: true })).rejects.toThrow(unknownError(firstId, NO_OUTCOME))
    expect(server.submits).toEqual([])
    // Without --replay-failed nothing is submitted, so nothing needs proof.
    const plain = await runOnce(server, { c1: lostContact })
    expect(plain.progress.c1).toMatchObject({ status: 'failed' })
    expect(server.submits).toEqual([])
  })

  // Finding 6: the replica that runs the replay can stamp it days before the
  // replica the bound came from. Pruned reads miss it; the last read does not.
  test('a replay stamped by a replica clock days behind the time probe still settles done', async () => {
    const server = createSimulatedServer({
      attempts: [killedFirst],
      nextOutcomes: ['finished'],
      submitClockOffsetMs: -3 * DAY_MS,
    })

    const result = await runOnce(server, { c1: { status: 'failed', queryId: firstId } }, { replayFailed: true, maxPollErrors: 4 })

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

    const result = await runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo() } })

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

    const result = await runOnce(server, { c1: { status: 'pending', submittedAt } })

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
      runOnce(server, { c1: { status: 'pending', queryId: recordedReplayId, submittedAt: hourAgo() } }),
    ).rejects.toThrow('could not check which chunks are still running on the server (Code: 210. NETWORK_ERROR)')
    expect(server.submits).toEqual([])
  })

  // Finding 4: a user denied clusterAllReplicas reads one replica. What it
  // finds there holds; what it does not find may be on another replica.
  test('a resume whose replica probe is denied trusts only what it finds, and submits nothing on an absence', async () => {
    const denied = 'Code: 497. DB::Exception: default: Not enough privileges. (ACCESS_DENIED)'
    const deny = (server: ReturnType<typeof createSimulatedServer>) => {
      const query = server.executor.query.bind(server.executor)
      server.executor.query = async <T>(sql: string, settings?: Record<string, unknown>): Promise<T[]> => {
        if (sql.includes('system.one')) throw Object.assign(new Error(denied), { code: '497' })
        return query<T>(sql, settings)
      }
    }
    const recorded = { c1: { status: 'pending' as const, queryId: recordedReplayId, submittedAt: hourAgo() } }

    const absent = createSimulatedServer({ attempts: [killedFirst], nextOutcomes: ['finished'] })
    deny(absent)
    await expect(runOnce(absent, recorded)).rejects.toThrow(
      unknownError(recordedReplayId, `the user may not read every replica (${denied}), and the replica it can read neither runs it nor has an outcome for it`),
    )
    expect(absent.submits).toEqual([])

    const found = createSimulatedServer({ attempts: [killedFirst, { queryId: recordedReplayId, outcome: 'finished' }] })
    deny(found)
    const result = await runOnce(found, recorded)
    expect(result.progress.c1).toMatchObject({ status: 'done', queryId: recordedReplayId })
    expect(found.submits).toEqual([])
  })
})
