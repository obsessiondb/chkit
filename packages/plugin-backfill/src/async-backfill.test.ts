import { describe, expect, test } from 'bun:test'
import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'
import { executeBackfill, type BackfillProgress } from './async-backfill.js'

function createMockExecutor(statuses: Map<string, QueryStatus[]>): ClickHouseExecutor {
  const callCounts = new Map<string, number>()

  return {
    async command() {},
    async query() { return [] },
    async insert() {},
    async listSchemaObjects() { return [] },
    async listTableDetails() { return [] },
    async submit(_sql: string, queryId?: string): Promise<string> {
      const id = queryId ?? crypto.randomUUID()
      return id
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
      ['backfill-c1', [{ status: 'running' }, { status: 'finished', writtenRows: 100, writtenBytes: 500, durationMs: 200 }]],
      ['backfill-c2', [{ status: 'finished', writtenRows: 50, writtenBytes: 250, durationMs: 100 }]],
    ])

    const result = await executeBackfill({
      executor: createMockExecutor(statuses),
      chunks,
      buildQuery: (c) => `INSERT INTO t SELECT * FROM s WHERE d >= '${c.from}' AND d < '${c.to}'`,
      concurrency: 2,
      pollIntervalMs: 10,
    })

    expect(result.total).toBe(2)
    expect(result.completed).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.progress['c1'].status).toBe('done')
    expect(result.progress['c2'].status).toBe('done')
    expect(result.progress['c1'].writtenRows).toBe(100)
  })

  test('reports failed chunks', async () => {
    const statuses = new Map<string, QueryStatus[]>([
      ['backfill-c1', [{ status: 'failed', error: 'OOM', durationMs: 50 }]],
      ['backfill-c2', [{ status: 'finished', writtenRows: 10, writtenBytes: 40, durationMs: 30 }]],
    ])

    const result = await executeBackfill({
      executor: createMockExecutor(statuses),
      chunks,
      buildQuery: () => 'SELECT 1',
      concurrency: 2,
      pollIntervalMs: 10,
    })

    expect(result.completed).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.progress['c1'].status).toBe('failed')
    expect(result.progress['c1'].error).toBe('OOM')
    expect(result.progress['c2'].status).toBe('done')
  })

  test('respects concurrency limit', async () => {
    const submitOrder: string[] = []
    const statuses = new Map<string, QueryStatus[]>([
      ['backfill-c1', [{ status: 'running' }, { status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]],
      ['backfill-c2', [{ status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]],
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
      chunks,
      buildQuery: () => 'SELECT 1',
      concurrency: 1,
      pollIntervalMs: 10,
    })

    expect(result.total).toBe(2)
    expect(result.completed).toBe(2)
    // With concurrency 1, c2 must be submitted after c1 finishes
    expect(submitOrder[0]).toBe('backfill-c1')
    expect(submitOrder[1]).toBe('backfill-c2')
  })

  test('calls onProgress on state changes', async () => {
    const statuses = new Map<string, QueryStatus[]>([
      ['backfill-c1', [{ status: 'finished', writtenRows: 1, writtenBytes: 1, durationMs: 1 }]],
    ])

    const progressSnapshots: BackfillProgress[] = []

    await executeBackfill({
      executor: createMockExecutor(statuses),
      chunks: [chunks[0]],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      onProgress: (p) => { progressSnapshots.push({ ...p }) },
    })

    expect(progressSnapshots.length).toBeGreaterThanOrEqual(1)
    // At least one snapshot should have a terminal state
    const lastSnapshot = progressSnapshots[progressSnapshots.length - 1]
    expect(lastSnapshot['c1'].status).toBe('done')
  })

  test('resumes from saved progress', async () => {
    const statuses = new Map<string, QueryStatus[]>([
      ['backfill-c1', [{ status: 'finished', writtenRows: 100, writtenBytes: 500, durationMs: 200 }]],
      ['backfill-c2', [{ status: 'finished', writtenRows: 50, writtenBytes: 250, durationMs: 100 }]],
    ])

    const resumeFrom: BackfillProgress = {
      c1: { status: 'done', queryId: 'backfill-c1', writtenRows: 100 },
      c2: { status: 'submitted', queryId: 'backfill-c2', submittedAt: '2024-01-01T00:00:00Z' },
    }

    const result = await executeBackfill({
      executor: createMockExecutor(statuses),
      chunks,
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 10,
      resumeFrom,
    })

    expect(result.completed).toBe(2)
    expect(result.failed).toBe(0)
    // c1 should remain done from resume
    expect(result.progress['c1'].status).toBe('done')
    expect(result.progress['c1'].writtenRows).toBe(100)
  })
})
