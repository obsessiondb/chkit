import { describe, expect, test } from 'bun:test'
import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'
import { executeBackfill, type BackfillProgress } from './async-backfill.js'

function executor(overrides: Partial<ClickHouseExecutor> = {}): ClickHouseExecutor {
  return {
    async command() {},
    async query() {
      return []
    },
    async insert() {},
    async listSchemaObjects() {
      return []
    },
    async listTableDetails() {
      return []
    },
    async submit(_sql, queryId) {
      return queryId ?? ''
    },
    async queryStatus(): Promise<QueryStatus> {
      return { status: 'finished' }
    },
    async close() {},
    ...overrides,
  }
}

describe('backfill execution lifetime', () => {
  test('observes reconciled running queries before admitting earlier pending chunks', async () => {
    const release = Promise.withResolvers<void>()
    const observing = Promise.withResolvers<void>()
    const submitted: string[] = []
    const run = executeBackfill({
      executor: executor({
        async query<T>(sql: string): Promise<T[]> {
          return (sql.includes('system.processes') ? [{ query_id: 'backfill-resumed-b' }] : []) as T[]
        },
        async submit(_sql, queryId = '') {
          submitted.push(queryId)
          return queryId
        },
        async queryStatus(queryId) {
          if (queryId === 'backfill-resumed-b') {
            observing.resolve()
            await release.promise
          }
          return { status: 'finished' }
        },
      }),
      planId: 'resumed',
      chunks: [{ id: 'a' }, { id: 'b' }],
      resumeFrom: { a: { status: 'pending' }, b: { status: 'pending' } },
      buildQuery: () => 'SELECT 1',
      concurrency: 1,
      pollIntervalMs: 1,
    })
    await observing.promise
    expect(submitted).toEqual([])
    release.resolve()
    expect((await run).completed).toBe(2)
    expect(submitted).toEqual(['backfill-resumed-a'])
  })

  test('bounds submitted server queries until their terminal poll, not just submission', async () => {
    const release = Promise.withResolvers<void>()
    const atCapacity = Promise.withResolvers<void>()
    const running = new Set<string>()
    const submitted: string[] = []
    let peak = 0
    let closed = 0
    const run = executeBackfill({
      executor: executor({
        async submit(_sql, queryId = '') {
          submitted.push(queryId)
          running.add(queryId)
          peak = Math.max(peak, running.size)
          if (running.size === 2) atCapacity.resolve()
          return queryId
        },
        async queryStatus(queryId) {
          await release.promise
          running.delete(queryId)
          return { status: 'finished' }
        },
        async close() {
          closed++
        },
      }),
      planId: 'lifetime',
      chunks: ['a', 'b', 'c', 'd'].map((id) => ({ id })),
      buildQuery: () => 'SELECT 1',
      concurrency: 2,
      pollIntervalMs: 1,
    })
    await atCapacity.promise
    expect(submitted).toEqual(['backfill-lifetime-a', 'backfill-lifetime-b'])
    expect(running.size).toBe(2)
    release.resolve()
    expect((await run).completed).toBe(4)
    expect(peak).toBe(2)
    expect(closed).toBe(0)
  })

  test('serializes progress publication and retains each immutable snapshot', async () => {
    const firstPublication = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const bothSubmitted = Promise.withResolvers<void>()
    const snapshots: BackfillProgress[] = []
    const completed: BackfillProgress[] = []
    let submissions = 0
    let active = 0
    let peak = 0
    const run = executeBackfill({
      executor: executor({
        async submit(_sql, queryId = '') {
          submissions++
          if (submissions === 2) bothSubmitted.resolve()
          return queryId
        },
      }),
      planId: 'publication',
      chunks: [{ id: 'a' }, { id: 'b' }],
      buildQuery: () => 'SELECT 1',
      concurrency: 2,
      pollIntervalMs: 1,
      async onProgress(progress) {
        active++
        peak = Math.max(peak, active)
        snapshots.push(progress)
        if (snapshots.length === 1) {
          firstPublication.resolve()
          await release.promise
        }
        completed.push(progress)
        active--
      },
    })
    await Promise.all([firstPublication.promise, bothSubmitted.promise])
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toEqual({
      a: { status: 'submitted', queryId: 'backfill-publication-a' },
      b: { status: 'pending' },
    })
    release.resolve()
    const result = await run
    expect(peak).toBe(1)
    expect(completed).toEqual(snapshots)
    expect(snapshots.at(-1)).toEqual(result.progress)
    expect(snapshots[0]?.b?.status).toBe('pending')
  })

  test('stops admission on a submission error and preserves caller ownership and the original error', async () => {
    const failure = new Error('submit refused')
    const submitted: string[] = []
    let closed = 0
    await expect(
      executeBackfill({
        executor: executor({
          async submit(_sql, queryId = '') {
            submitted.push(queryId)
            throw failure
          },
          async close() {
            closed++
          },
        }),
        planId: 'failed-submit',
        chunks: [{ id: 'a' }, { id: 'b' }],
        buildQuery: () => 'SELECT 1',
        concurrency: 1,
      }),
    ).rejects.toBe(failure)
    expect(submitted).toEqual(['backfill-failed-submit-a'])
    expect(closed).toBe(0)
  })

  test('does not retry a failed progress observer or reinterpret it as a failed SQL query', async () => {
    const failure = { message: 'checkpoint storage rejected' }
    let calls = 0
    let polls = 0
    let closed = 0
    await expect(
      executeBackfill({
        executor: executor({
          async queryStatus() {
            polls++
            return { status: 'finished' }
          },
          async close() {
            closed++
          },
        }),
        planId: 'failed-observer',
        chunks: [{ id: 'a' }],
        buildQuery: () => 'SELECT 1',
        pollIntervalMs: 1,
        onProgress() {
          calls++
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    expect(calls).toBe(1)
    expect(polls).toBe(0)
    expect(closed).toBe(0)
  })

  test('resets the poll error retry budget after a successful unknown response', async () => {
    let polls = 0
    const result = await executeBackfill({
      executor: executor({
        async queryStatus() {
          polls++
          if (polls === 1 || polls === 3) throw new Error('temporary disconnect')
          return { status: polls === 2 ? 'unknown' : 'finished' }
        },
      }),
      planId: 'poll-budget',
      chunks: [{ id: 'a' }],
      buildQuery: () => 'SELECT 1',
      pollIntervalMs: 1,
      maxPollErrors: 2,
    })
    expect(polls).toBe(4)
    expect(result.completed).toBe(1)
  })

  test('preserves Infinity concurrency for a finite chunk list', async () => {
    const result = await executeBackfill({
      executor: executor(),
      planId: 'all-chunks',
      chunks: [{ id: 'a' }, { id: 'b' }],
      buildQuery: () => 'SELECT 1',
      concurrency: Number.POSITIVE_INFINITY,
      pollIntervalMs: 1,
    })
    expect(result.completed).toBe(2)
  })

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid concurrency %s before submitting', async (concurrency) => {
    let submitted = 0
    await expect(
      executeBackfill({
        executor: executor({
          async submit() {
            submitted++
            return ''
          },
        }),
        planId: 'invalid-capacity',
        chunks: [{ id: 'a' }],
        buildQuery: () => 'SELECT 1',
        concurrency,
      }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(submitted).toBe(0)
  })
})
