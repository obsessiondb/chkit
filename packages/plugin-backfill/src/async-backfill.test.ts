import { describe, expect, test } from 'bun:test'
import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'
import { executeBackfill, syncProgress, type BackfillProgress } from './async-backfill.js'

const PLAN_ID = 'test-plan'

/** Match query IDs by chunk prefix (e.g. "backfill-test-plan-c1") */
function createMockExecutor(statuses: Map<string, QueryStatus[]>): ClickHouseExecutor {
  const callCounts = new Map<string, number>()

  return {
    async command() {},
    async query() { return [] },
    async insert() {},
    async listSchemaObjects() { return [] },
    async listTableDetails() { return [] },
    async submit(_sql: string, queryId?: string): Promise<string> {
      return queryId ?? crypto.randomUUID()
    },
    async queryStatus(queryId: string): Promise<QueryStatus> {
      const list = statuses.get(queryId) ?? [{ status: 'unknown' }]
      const count = callCounts.get(queryId) ?? 0
      callCounts.set(queryId, count + 1)
      return list[Math.min(count, list.length - 1)]
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
    let callCount = 0
    const executor = createMockExecutor(new Map())
    executor.queryStatus = async (): Promise<QueryStatus> => {
      callCount++
      if (callCount <= 2) throw new Error('ECONNRESET')
      return { status: 'finished', writtenRows: 10, writtenBytes: 40, durationMs: 30 }
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

  test('fails chunk after max consecutive poll errors', async () => {
    const executor = createMockExecutor(new Map())
    executor.queryStatus = async (): Promise<QueryStatus> => {
      throw new Error('ETIMEDOUT')
    }

    const result = await executeBackfill({
      executor,
      planId: PLAN_ID,
      chunks: [chunks[0]],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      maxPollErrors: 3,
    })

    expect(result.completed).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.progress.c1.status).toBe('failed')
    expect(result.progress.c1.error).toContain('3 consecutive poll errors')
  })

  test('replayFailed resets failed chunks after sync', async () => {
    const queryId = `backfill-${PLAN_ID}-c1`
    const statuses = new Map<string, QueryStatus[]>([
      [queryId, [{ status: 'finished', writtenRows: 42, writtenBytes: 200, durationMs: 80 }]],
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
    expect(result.progress.c1.writtenRows).toBe(42)
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
      c1: { status: 'submitted', queryId: `backfill-${PLAN_ID}-c1`, submittedAt: '2024-01-01T00:00:00Z' },
    }

    const synced = await syncProgress(executor, PLAN_ID, [{ id: 'c1' }], progress)
    expect(synced.c1.status).toBe('failed')
    expect(synced.c1.error).toBe('Memory limit exceeded')
  })
})
