import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  createLiveExecutor,
  createPrefix,
  createStatelessLiveExecutor,
  getRequiredEnv,
} from '@chkit/clickhouse/e2e-testkit'
import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { executeBackfill, type BackfillProgress } from './async-backfill.js'
import { analyzeAndChunk } from './chunking/analyze.js'
import { buildChunkExecutionSql } from './chunking/sql.js'
import type { ChunkPlan, PlannerQuery } from './chunking/types.js'

// ---------------------------------------------------------------------------
// Live execute-loop coverage.
//
// The chunk planner already has live e2e coverage (chunking/e2e). What was
// missing is a test that actually drives `executeBackfill` against a real
// cluster: submitting the chunk INSERT…SELECTs, polling system.processes /
// system.query_log to completion, and verifying the data lands. This file
// covers the full run plus the resume and replay-failed paths, which were
// previously only exercised against a mock executor.
// ---------------------------------------------------------------------------

const SOURCE_ROWS = 2000

// DDL / inserts / counts go through the session-bound executor (sequential).
let ddl: ClickHouseExecutor
// The execute loop submits + polls in parallel; a stateless executor avoids
// ObsessionDB session-locking errors under concurrency (same reason the
// chunking planner e2e uses a stateless executor).
let runExecutor: ClickHouseExecutor
let plannerQuery: PlannerQuery
let db: string
let sourceTable: string
let sourceFqn: string
let targetFqn: string
let plan: ChunkPlan

function tableDdl(fqn: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${fqn} (
      id UInt64,
      bucket UInt8,
      payload String
    ) ENGINE = MergeTree()
    PARTITION BY bucket
    ORDER BY id
  `
}

async function countRows(fqn: string): Promise<number> {
  const [row] = await ddl.query<{ cnt: string }>(
    `SELECT count() AS cnt FROM ${fqn} SETTINGS select_sequential_consistency = 1`,
  )
  return Number(row?.cnt ?? 0)
}

function sqlForChunk(chunkId: string): string {
  const chunk = plan.chunks.find((candidate) => candidate.id === chunkId)
  if (!chunk) throw new Error(`Chunk ${chunkId} is not part of the plan`)
  return buildChunkExecutionSql({
    planId: plan.planId,
    chunk,
    target: targetFqn,
    sourceTarget: sourceFqn,
    table: plan.table,
  })
}

beforeAll(async () => {
  const env = getRequiredEnv()
  db = env.clickhouseDatabase
  ddl = createLiveExecutor(env)
  runExecutor = createStatelessLiveExecutor(env)
  plannerQuery = async <T>(
    sql: string,
    settings?: Record<string, string | number | boolean | undefined>,
  ): Promise<T[]> => runExecutor.query<T>(sql, settings)

  const prefix = createPrefix('backfill_exec')
  sourceTable = `${prefix}source`
  sourceFqn = `${db}.${sourceTable}`
  targetFqn = `${db}.${prefix}target`

  await ddl.command(tableDdl(sourceFqn))
  await ddl.command(tableDdl(targetFqn))

  const rows = Array.from({ length: SOURCE_ROWS }, (_, i) => ({
    id: i,
    bucket: i % 4,
    payload: 'x'.repeat(256),
  }))
  await ddl.insert({ table: sourceFqn, values: rows })

  // Target a few chunks per run so resume/replay operate on more than one chunk.
  const [bytesRow] = await ddl.query<{ total: string }>(`
    SELECT toString(sum(data_uncompressed_bytes)) AS total
    FROM system.parts
    WHERE database = '${db}' AND table = '${sourceTable}' AND active = 1
    SETTINGS select_sequential_consistency = 1
  `)
  const uncompressedBytes = Number(bytesRow?.total ?? 0)
  const targetChunkBytes = Math.max(1, Math.floor(uncompressedBytes / 4))

  plan = await analyzeAndChunk({
    database: db,
    table: sourceTable,
    targetChunkBytes,
    query: plannerQuery,
    querySettings: { enable_parallel_replicas: 0 },
  })
}, 120_000)

afterAll(async () => {
  if (sourceFqn) await ddl.command(`DROP TABLE IF EXISTS ${sourceFqn}`)
  if (targetFqn) await ddl.command(`DROP TABLE IF EXISTS ${targetFqn}`)
  await runExecutor?.close()
  await ddl?.close()
})

describe('e2e: executeBackfill against a live cluster', () => {
  test('produces a multi-chunk plan to exercise the loop', () => {
    expect(plan.chunks.length).toBeGreaterThan(1)
  })

  test('full backfill copies every source row into the target', async () => {
    await ddl.command(`TRUNCATE TABLE ${targetFqn}`)

    const result = await executeBackfill({
      executor: runExecutor,
      planId: `${plan.planId}-full`,
      chunks: plan.chunks,
      buildQuery: ({ id }) => sqlForChunk(id),
      concurrency: 3,
      pollIntervalMs: 1500,
    })

    expect(result.total).toBe(plan.chunks.length)
    expect(result.failed).toBe(0)
    expect(result.completed).toBe(plan.chunks.length)

    expect(await countRows(sourceFqn)).toBe(SOURCE_ROWS)
    expect(await countRows(targetFqn)).toBe(SOURCE_ROWS)
  }, 120_000)

  test('resume skips already-completed chunks without re-inserting them', async () => {
    await ddl.command(`TRUNCATE TABLE ${targetFqn}`)

    // Simulate a prior run that finished exactly the first chunk: insert its
    // rows out-of-band and mark it done in the resume checkpoint.
    const firstChunkId = plan.chunks[0]?.id
    if (!firstChunkId) throw new Error('plan produced no chunks')
    await ddl.command(sqlForChunk(firstChunkId))
    expect(await countRows(targetFqn)).toBeGreaterThan(0)

    const resumeFrom: BackfillProgress = { [firstChunkId]: { status: 'done' } }

    const result = await executeBackfill({
      executor: runExecutor,
      planId: `${plan.planId}-resume`,
      chunks: plan.chunks,
      buildQuery: ({ id }) => sqlForChunk(id),
      concurrency: 3,
      pollIntervalMs: 1500,
      resumeFrom,
    })

    expect(result.failed).toBe(0)
    expect(result.completed).toBe(plan.chunks.length)
    // Re-running the first chunk would push the target above the source count;
    // an exact match proves it was skipped, not duplicated.
    expect(await countRows(targetFqn)).toBe(SOURCE_ROWS)
  }, 120_000)

  test('replayFailed re-runs a failed chunk and restores the full row count', async () => {
    await ddl.command(`TRUNCATE TABLE ${targetFqn}`)

    // Simulate a prior run where every chunk except the first one succeeded.
    const chunkIds = plan.chunks.map((chunk) => chunk.id)
    const failedId = chunkIds[0]
    if (!failedId) throw new Error('plan produced no chunks')
    const succeededIds = chunkIds.slice(1)
    expect(succeededIds.length).toBeGreaterThan(0)

    for (const id of succeededIds) {
      await ddl.command(sqlForChunk(id))
    }
    expect(await countRows(targetFqn)).toBeLessThan(SOURCE_ROWS)

    const resumeFrom: BackfillProgress = {
      [failedId]: { status: 'failed', error: 'simulated failure' },
      ...Object.fromEntries(
        succeededIds.map((id) => [id, { status: 'done' as const }]),
      ),
    }

    const result = await executeBackfill({
      executor: runExecutor,
      planId: `${plan.planId}-replay`,
      chunks: plan.chunks,
      buildQuery: ({ id }) => sqlForChunk(id),
      concurrency: 3,
      pollIntervalMs: 1500,
      resumeFrom,
      replayFailed: true,
    })

    expect(result.failed).toBe(0)
    expect(result.completed).toBe(plan.chunks.length)
    expect(await countRows(targetFqn)).toBe(SOURCE_ROWS)
  }, 120_000)
})
