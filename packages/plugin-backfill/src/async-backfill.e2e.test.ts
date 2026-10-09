import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  createLiveExecutor,
  createPrefix,
  createStatelessLiveExecutor,
  getLiveEnv,
  pollUntil,
  quoteIdent,
  type LiveEnv,
} from '@chkit/clickhouse/e2e-testkit'
import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { executeBackfill, type BackfillProgress, type BackfillResult } from './async-backfill.js'
import { analyzeAndChunk } from './chunking/analyze.js'
import { buildChunkExecutionSql } from './chunking/sql.js'
import type { ChunkPlan, PlannerQuery } from './chunking/types.js'
import {
  resolveReplicaVisibility,
  syncReplicaUnlessDenied,
  type ReplicaVisibility,
} from './mv-replay-visibility.js'

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
const BUCKETS = 4
// A finished empty INSERT is still QueryFinish. Reusing the plan id reuses
// executeBackfill's deterministic query id, so the next poll reads that 0-row
// log line and never observes the retry. A new plan id is a new query id.
const MAX_EMPTY_CHUNK_REPLAYS = 3

// DDL / inserts / counts go through the session-bound executor (sequential).
let ddl: ClickHouseExecutor
// The execute loop submits + polls in parallel; a stateless executor avoids
// ObsessionDB session-locking errors under concurrency (same reason the
// chunking planner e2e uses a stateless executor).
let runExecutor: ClickHouseExecutor
let plannerQuery: PlannerQuery
let liveEnv: LiveEnv
let db: string
// Plain MergeTree has one copy of the data. Replicated/Shared engines sync
// each sampled replica before a chunk reads it, when those commands are granted.
let replicaVisibility: ReplicaVisibility = { kind: 'single-node', samples: 1 }
let syncReplicaDenied = false
let sourceTable: string
let targetTable: string
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
  // Parallel replicas are on by default on ObsessionDB. A follower that has not
  // attached a partition contributes an empty partial aggregate, so count()
  // can report one bucket (SOURCE_ROWS / BUCKETS) while the insert session
  // still sees every source row.
  const [row] = await ddl.query<{ cnt: string }>(
    `SELECT count() AS cnt FROM ${fqn} SETTINGS select_sequential_consistency = 1, enable_parallel_replicas = 0`,
  )
  return Number(row?.cnt ?? 0)
}

async function readTargetRows(): Promise<number> {
  if (replicaVisibility.kind !== 'single-node' && !syncReplicaDenied) {
    const sync = await syncReplicaUnlessDenied(() =>
      ddl.command(
        `SYSTEM SYNC REPLICA ${quoteIdent(db)}.${quoteIdent(targetTable)} LIGHTWEIGHT`,
      ),
    )
    if (sync === 'denied') syncReplicaDenied = true
  }
  return countRows(targetFqn)
}

async function truncateTarget(): Promise<void> {
  await ddl.command(`TRUNCATE TABLE ${targetFqn}`)
  const remaining = await pollUntil(readTargetRows, (rows) => rows === 0)
  expect(remaining).toBe(0)
}

// Chunk queries are fire-and-forget on a stateless client, so each one can
// land on a different replica than the session that inserted the source.
// select_sequential_consistency does not fetch parts that were never quorum
// commits. A replica that has not attached a partition finishes the INSERT
// with 0 written rows. Sample a fresh session per active replica, and on
// replicated/shared engines sync that session's replica before counting.
// When system.replicas (or SYSTEM SYNC REPLICA) is not granted, this wait
// only proves one session can see the source. enable_parallel_replicas = 0
// and the empty-chunk replay below still cover a replica this wait missed.
async function waitUntilSourceVisible(): Promise<void> {
  let readySamples = 0
  const ready = await pollUntil(async () => {
    const session = createLiveExecutor(liveEnv)
    try {
      if (replicaVisibility.kind !== 'single-node' && !syncReplicaDenied) {
        const sync = await syncReplicaUnlessDenied(() =>
          session.command(
            `SYSTEM SYNC REPLICA ${quoteIdent(db)}.${quoteIdent(sourceTable)} LIGHTWEIGHT`,
          ),
        )
        if (sync === 'denied') syncReplicaDenied = true
      }
      const [countRow] = await session.query<{ cnt: string }>(
        `SELECT toString(count()) AS cnt FROM ${sourceFqn} SETTINGS select_sequential_consistency = 1, enable_parallel_replicas = 0`,
      )
      const [partsRow] = await session.query<{ partitions: string; rows: string }>(`
        SELECT toString(uniqExact(partition_id)) AS partitions, toString(sum(rows)) AS rows
        FROM system.parts
        WHERE database = '${db}' AND table = '${sourceTable}' AND active = 1
        SETTINGS select_sequential_consistency = 1
      `)
      const fullSource = Number(countRow?.cnt ?? 0) === SOURCE_ROWS
        && Number(partsRow?.partitions ?? 0) === BUCKETS
        && Number(partsRow?.rows ?? 0) === SOURCE_ROWS
      if (fullSource) readySamples += 1
      return readySamples
    } finally {
      await session.close()
    }
  }, (samples) => samples >= replicaVisibility.samples, { timeoutMs: 45_000, intervalMs: 250 })
  expect(ready, `replicas that can see all ${SOURCE_ROWS} source rows across ${BUCKETS} partitions (${replicaVisibility.kind})`).toBeGreaterThanOrEqual(replicaVisibility.samples)
}

function sqlForChunk(chunkId: string, planId = plan.planId): string {
  const chunk = plan.chunks.find((candidate) => candidate.id === chunkId)
  if (!chunk) throw new Error(`Chunk ${chunkId} is not part of the plan`)
  // A stale follower can answer one partition with an empty scan while the
  // coordinator still reports the INSERT finished. Planning already disables
  // parallel replicas for the same reason.
  return `${buildChunkExecutionSql({
    planId,
    chunk,
    target: targetFqn,
    sourceTarget: sourceFqn,
    table: plan.table,
  })}, select_sequential_consistency = 1, enable_parallel_replicas = 0`
}

function emptyChunkIds(result: BackfillResult): string[] {
  return Object.entries(result.progress)
    .filter(([, chunk]) => chunk.status === 'done' && chunk.writtenRows === 0)
    .map(([id]) => id)
}

function writtenRowsByChunk(result: BackfillResult): Record<string, number | undefined> {
  return Object.fromEntries(
    Object.entries(result.progress).map(([id, chunk]) => [id, chunk.writtenRows]),
  )
}

async function settledTargetRows(): Promise<number> {
  return pollUntil(readTargetRows, (rows) => rows === SOURCE_ROWS, { timeoutMs: 45_000 })
}

beforeAll(async () => {
  liveEnv = getLiveEnv()
  db = liveEnv.clickhouseDatabase
  ddl = createLiveExecutor(liveEnv)
  runExecutor = createStatelessLiveExecutor(liveEnv)
  plannerQuery = async <T>(
    sql: string,
    settings?: Record<string, string | number | boolean | undefined>,
  ): Promise<T[]> => runExecutor.query<T>(sql, settings)

  const prefix = createPrefix('backfill_exec')
  sourceTable = `${prefix}source`
  targetTable = `${prefix}target`
  sourceFqn = `${db}.${sourceTable}`
  targetFqn = `${db}.${targetTable}`

  await ddl.command(tableDdl(sourceFqn))
  await ddl.command(tableDdl(targetFqn))

  const [engineRow] = await ddl.query<{ engine: string }>(
    `SELECT engine FROM system.tables WHERE database = '${db}' AND name = '${sourceTable}'`,
  )
  replicaVisibility = await resolveReplicaVisibility(engineRow?.engine, async () => {
    const [replicaRow] = await ddl.query<{ active: string }>(
      `SELECT toString(active_replicas) AS active
       FROM system.replicas
       WHERE database = '${db}' AND table = '${sourceTable}'`,
    )
    return Number(replicaRow?.active ?? 0)
  })

  const rows = Array.from({ length: SOURCE_ROWS }, (_, i) => ({
    id: i,
    bucket: i % BUCKETS,
    payload: 'x'.repeat(256),
  }))
  await ddl.insert({ table: sourceFqn, values: rows })

  // The insert returning does not mean every replica (or system.parts) can see
  // all four partitions. Planning off a partial parts list builds a plan that
  // can only copy one bucket, which is SOURCE_ROWS / BUCKETS.
  await waitUntilSourceVisible()

  plan = await pollUntil(async () => {
    const [bytesRow] = await ddl.query<{ total: string }>(`
      SELECT toString(sum(data_uncompressed_bytes)) AS total
      FROM system.parts
      WHERE database = '${db}' AND table = '${sourceTable}' AND active = 1
      SETTINGS select_sequential_consistency = 1
    `)
    const uncompressedBytes = Number(bytesRow?.total ?? 0)
    // Target a few chunks per run so resume/replay operate on more than one chunk.
    const targetChunkBytes = Math.max(1, Math.floor(uncompressedBytes / BUCKETS))
    return analyzeAndChunk({
      database: db,
      table: sourceTable,
      targetChunkBytes,
      query: plannerQuery,
      querySettings: { enable_parallel_replicas: 0 },
    })
  }, (candidate) => candidate.partitions.length === BUCKETS && candidate.totalRows === SOURCE_ROWS, {
    timeoutMs: 45_000,
    intervalMs: 1000,
  })
}, 180_000)

afterAll(async () => {
  if (sourceFqn) await ddl.command(`DROP TABLE IF EXISTS ${sourceFqn}`)
  if (targetFqn) await ddl.command(`DROP TABLE IF EXISTS ${targetFqn}`)
  await runExecutor?.close()
  await ddl?.close()
})

describe('e2e: executeBackfill against a live cluster', () => {
  test('produces a multi-chunk plan to exercise the loop', () => {
    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.partitions.length, `planned rows=${plan.totalRows}`).toBe(BUCKETS)
    expect(plan.totalRows).toBe(SOURCE_ROWS)
  })

  test('full backfill copies every source row into the target', async () => {
    await truncateTarget()
    await waitUntilSourceVisible()

    const runChunks = (planId: string, chunkIds: string[]) => executeBackfill({
      executor: runExecutor,
      planId,
      chunks: chunkIds.map((id) => ({ id })),
      buildQuery: ({ id }) => sqlForChunk(id, planId),
      concurrency: 3,
      pollIntervalMs: 1500,
    })

    const initial = await runChunks(`${plan.planId}-full`, plan.chunks.map((chunk) => chunk.id))
    expect(initial.total).toBe(plan.chunks.length)
    expect(initial.failed).toBe(0)
    expect(initial.completed).toBe(plan.chunks.length)

    const writtenAttempts = [writtenRowsByChunk(initial)]
    let missing = emptyChunkIds(initial)
    for (let attempt = 1; missing.length > 0 && attempt <= MAX_EMPTY_CHUNK_REPLAYS; attempt++) {
      await waitUntilSourceVisible()
      const retry = await runChunks(`${plan.planId}-full-r${attempt}`, missing)
      expect(retry.failed).toBe(0)
      expect(retry.completed).toBe(missing.length)
      writtenAttempts.push(writtenRowsByChunk(retry))
      missing = emptyChunkIds(retry)
    }

    expect(await countRows(sourceFqn)).toBe(SOURCE_ROWS)
    const targetRows = await settledTargetRows()
    expect(
      targetRows,
      `rows written per chunk attempt: ${JSON.stringify(writtenAttempts)} (${replicaVisibility.kind}, syncDenied=${syncReplicaDenied}, emptyChunks=${missing.join(',') || 'none'})`,
    ).toBe(SOURCE_ROWS)
  }, 240_000)

  test('resume skips already-completed chunks without re-inserting them', async () => {
    await truncateTarget()
    await waitUntilSourceVisible()

    // Simulate a prior run that finished exactly the first chunk: insert its
    // rows out-of-band and mark it done in the resume checkpoint.
    const firstChunkId = plan.chunks[0]?.id
    if (!firstChunkId) throw new Error('plan produced no chunks')
    await ddl.command(sqlForChunk(firstChunkId))
    const seeded = await pollUntil(readTargetRows, (rows) => rows > 0)
    expect(seeded).toBeGreaterThan(0)

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
    // an exact match proves it was skipped, not duplicated. Polling stops at
    // the first exact read, so a duplicate still fails this assertion.
    const targetRows = await settledTargetRows()
    expect(targetRows).toBe(SOURCE_ROWS)
  }, 240_000)

  test('replayFailed re-runs a failed chunk and restores the full row count', async () => {
    await truncateTarget()
    await waitUntilSourceVisible()

    // Simulate a prior run where every chunk except the first one succeeded.
    const chunkIds = plan.chunks.map((chunk) => chunk.id)
    const failedId = chunkIds[0]
    if (!failedId) throw new Error('plan produced no chunks')
    const succeededIds = chunkIds.slice(1)
    expect(succeededIds.length).toBeGreaterThan(0)

    for (const id of succeededIds) {
      await ddl.command(sqlForChunk(id))
    }
    const partial = await pollUntil(
      readTargetRows,
      (rows) => rows > 0 && rows < SOURCE_ROWS,
    )
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(SOURCE_ROWS)

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
    const targetRows = await settledTargetRows()
    expect(targetRows).toBe(SOURCE_ROWS)
  }, 240_000)
})
