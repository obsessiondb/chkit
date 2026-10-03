import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveConfig } from '@chkit/core'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import {
  createLiveExecutor,
  createPrefix,
  createStatelessLiveExecutor,
  getLiveEnv,
  pollUntil,
  quoteIdent,
  waitForTable,
  type LiveEnv,
} from '@chkit/clickhouse/e2e-testkit'

import { executeBackfill, type BackfillResult } from './async-backfill.js'
import { buildChunkExecutionSql } from './chunking/sql.js'
import { generateIdempotencyToken } from './chunking/utils/ids.js'
import {
  resolveReplicaVisibility,
  syncReplicaUnlessDenied,
  type ReplicaVisibility,
} from './mv-replay-visibility.js'
import { PlanSchema } from './options.js'
import { buildBackfillPlan } from './planner.js'
import type { Chunk, PlannerQuery } from './chunking/types.js'
import type { BackfillPlanState } from './types.js'

// ---------------------------------------------------------------------------
// Regression e2e for chkit#187: an mv_replay backfill of a from-scratch EMPTY
// aggregate target must plan its chunks against the MV *source* (the table the
// view reads), not the target. Before the fix, planning introspected the empty
// target and failed with "No partitions found for <target>".
//
// This drives the full path against a live cluster: buildBackfillPlan (schema
// load → MV detection → source introspection → chunking) followed by
// executeBackfill running the generated INSERT…SELECTs, then verifies the
// populated target matches the forward MV output.
// ---------------------------------------------------------------------------

const SOURCE_ROWS = 4000
const BUCKETS = 4
// Replaying a chunk under the same plan id reuses its dedup token. An empty
// INSERT can record that token, and the next attempt then commits nothing again.
const MAX_EMPTY_CHUNK_REPLAYS = 3

// DDL / inserts / counts go through the session-bound executor (sequential).
let ddl: ClickHouseExecutor
// The execute loop submits + polls in parallel; a stateless executor avoids
// ObsessionDB session-locking errors under concurrency.
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
let dir: string
let configPath: string

async function aggregateByBucket(fqn: string, valueExpr: string): Promise<Array<{ bucket: string; total: string }>> {
  return ddl.query<{ bucket: string; total: string }>(
    `SELECT toString(bucket) AS bucket, toString(${valueExpr}) AS total
     FROM ${fqn}
     GROUP BY bucket
     ORDER BY bucket
     SETTINGS select_sequential_consistency = 1`,
  )
}

// Chunk queries are fire-and-forget on a stateless client, so each one can
// land on a different replica than the session that inserted the source.
// select_sequential_consistency does not fetch parts that were never quorum
// commits; it only hides or rejects blocks the quorum has not confirmed. A
// replica that has not attached the partition therefore finishes the INSERT
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
      const [row] = await session.query<{ cnt: string }>(
        `SELECT toString(count()) AS cnt FROM ${sourceFqn} SETTINGS select_sequential_consistency = 1`,
      )
      if (Number(row?.cnt ?? 0) === SOURCE_ROWS) readySamples += 1
      return readySamples
    } finally {
      await session.close()
    }
  }, (samples) => samples >= replicaVisibility.samples, { timeoutMs: 45_000, intervalMs: 250 })
  expect(ready, `replicas that can see all ${SOURCE_ROWS} source rows (${replicaVisibility.kind})`).toBeGreaterThanOrEqual(replicaVisibility.samples)
}

function chunkExecutionSql(planId: string, chunk: Chunk, plan: BackfillPlanState): string {
  // enable_parallel_replicas is on by default on ObsessionDB. A stale follower
  // can answer one partition with an empty scan while the coordinator still
  // reports the query finished. Planning already disables it for the same reason.
  return `${buildChunkExecutionSql({
    planId,
    chunk,
    target: plan.target,
    sourceTarget: plan.execution.sourceTarget,
    table: plan.chunkPlan.table,
    mvReplayQueries: plan.execution.mvReplayQueries,
    targetColumns: plan.execution.targetColumns,
    idempotencyToken: plan.execution.requireIdempotencyToken
      ? generateIdempotencyToken(planId, chunk.id)
      : '',
  })}, select_sequential_consistency = 1, enable_parallel_replicas = 0`
}

function emptyChunkIds(result: BackfillResult): string[] {
  return Object.entries(result.progress)
    .filter(([, chunk]) => chunk.status === 'done' && (chunk.writtenRows ?? 0) === 0)
    .map(([id]) => id)
}

function writtenRowsByChunk(result: BackfillResult): Record<string, number | undefined> {
  return Object.fromEntries(
    Object.entries(result.progress).map(([id, chunk]) => [id, chunk.writtenRows]),
  )
}

function schemaSource(): string {
  // Plain-object definitions (no imports) so loadSchemaDefinitions can evaluate
  // the file straight from a temp dir, matching the unit-test convention.
  return `export const events_target = {
  kind: 'table',
  database: '${db}',
  name: '${targetTable}',
  columns: [
    { name: 'bucket', type: 'UInt8' },
    { name: 'total', type: 'UInt64' },
  ],
  engine: 'SummingMergeTree',
  primaryKey: ['bucket'],
  orderBy: ['bucket'],
}
export const events_mv = {
  kind: 'materialized_view',
  database: '${db}',
  name: '${sourceTable}_mv',
  to: { database: '${db}', name: '${targetTable}' },
  as: 'SELECT bucket, sum(id) AS total FROM ${db}.${sourceTable} GROUP BY bucket',
}
`
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

  const prefix = createPrefix('backfill_mvreplay')
  sourceTable = `${prefix}source`
  targetTable = `${prefix}agg`
  sourceFqn = `${db}.${sourceTable}`
  targetFqn = `${db}.${targetTable}`

  // Partitioned source with real data.
  await ddl.command(`
    CREATE TABLE IF NOT EXISTS ${sourceFqn} (
      id UInt64,
      bucket UInt8,
      payload String
    ) ENGINE = MergeTree()
    PARTITION BY bucket
    ORDER BY id
  `)
  // Aggregate target that starts EMPTY — the scenario the bug blocked.
  await ddl.command(`
    CREATE TABLE IF NOT EXISTS ${targetFqn} (
      bucket UInt8,
      total UInt64
    ) ENGINE = SummingMergeTree()
    ORDER BY bucket
  `)
  await waitForTable(ddl, db, sourceTable)
  await waitForTable(ddl, db, targetTable)

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

  dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-mvreplay-'))
  configPath = join(dir, 'clickhouse.config.ts')
  await writeFile(join(dir, 'schema.ts'), schemaSource())
}, 120_000)

afterAll(async () => {
  if (sourceFqn) await ddl.command(`DROP TABLE IF EXISTS ${sourceFqn}`)
  if (targetFqn) await ddl.command(`DROP TABLE IF EXISTS ${targetFqn}`)
  if (dir) await rm(dir, { recursive: true, force: true })
  await runExecutor?.close()
  await ddl?.close()
})

describe('e2e: mv_replay backfill of an empty aggregate target (chkit#187)', () => {
  test('plans from the source, then executeBackfill populates the empty target to match the forward MV', async () => {
    // Confirm the target really is empty before we plan against it.
    expect(await aggregateByBucket(targetFqn, 'sum(total)')).toHaveLength(0)

    const config = resolveConfig({ schema: './schema.ts', metaDir: './chkit/meta' })

    // Size chunks so each source partition is one chunk (partition-aligned, no
    // intra-partition range splitting) — the same shape the copy e2e uses. This
    // keeps the test on the part the fix touches (source introspection + the
    // per-partition INSERT…SELECT) rather than the sort-key splitter.
    const [bytesRow] = await ddl.query<{ total: string }>(`
      SELECT toString(sum(data_uncompressed_bytes)) AS total
      FROM system.parts
      WHERE database = '${db}' AND table = '${sourceTable}' AND active = 1
      SETTINGS select_sequential_consistency = 1
    `)
    const uncompressedBytes = Number(bytesRow?.total ?? 0)
    expect(uncompressedBytes).toBeGreaterThan(0)

    const opts = PlanSchema.parse({ target: targetFqn, maxChunkBytes: uncompressedBytes })

    // The bug: this threw "No partitions found for <target>". Now it plans off
    // the source instead.
    const output = await buildBackfillPlan({
      opts,
      configPath,
      config,
      clickhouseQuery: plannerQuery,
      querySettings: { enable_parallel_replicas: 0 },
    })

    const plan: BackfillPlanState = output.plan
    expect(plan.execution.mode).toBe('mv_replay')
    // Chunk plan is sourced from the MV's FROM table, not the empty target.
    expect(plan.chunkPlan.table.database).toBe(db)
    expect(plan.chunkPlan.table.table).toBe(sourceTable)
    // One chunk per source partition — a real multi-chunk plan over the source.
    expect(plan.chunkPlan.chunks.length).toBe(BUCKETS)

    const runChunks = (planId: string, chunkIds: string[]) => executeBackfill({
      executor: runExecutor,
      planId,
      chunks: chunkIds.map((id) => ({ id })),
      buildQuery: ({ id }) => {
        const planChunk = plan.chunkPlan.chunks.find((candidate) => candidate.id === id)
        if (!planChunk) throw new Error(`Chunk ${id} not found in plan`)
        return chunkExecutionSql(planId, planChunk, plan)
      },
      concurrency: 3,
      pollIntervalMs: 1500,
    })

    // The source insert has already returned, but another replica may not
    // have attached those parts yet. Sync and count before any chunk reads.
    await waitUntilSourceVisible()

    let result = await runChunks(plan.planId, plan.chunkPlan.chunks.map((chunk) => chunk.id))
    const writtenAttempts = [writtenRowsByChunk(result)]
    let missing = emptyChunkIds(result)
    for (let attempt = 1; missing.length > 0 && attempt <= MAX_EMPTY_CHUNK_REPLAYS; attempt++) {
      // A new plan id is a new query id and a new dedup token. Reusing the
      // token from the empty INSERT would commit another 0-row replay.
      await waitUntilSourceVisible()
      const retry = await runChunks(`${plan.planId}-r${attempt}`, missing)
      expect(retry.failed).toBe(0)
      expect(retry.completed).toBe(missing.length)
      writtenAttempts.push(writtenRowsByChunk(retry))
      result = { ...result, progress: { ...result.progress, ...retry.progress } }
      missing = emptyChunkIds(retry)
    }

    const failed = Object.values(result.progress).filter((chunk) => chunk.status === 'failed').length
    const completed = Object.values(result.progress).filter((chunk) => chunk.status === 'done').length
    expect(failed).toBe(0)
    expect(completed).toBe(plan.chunkPlan.chunks.length)

    // Per-bucket values must match a forward run of the MV over the whole source.
    const expected = await aggregateByBucket(sourceFqn, 'sum(id)')
    expect(expected).toHaveLength(BUCKETS)
    // Poll the target read too: a finished INSERT's parts can still be
    // settling on the replica serving the SELECT. Data that never landed
    // still fails the diff below instead of being waited away.
    const actual = await pollUntil(
      () => aggregateByBucket(targetFqn, 'sum(total)'),
      (rows) => Bun.deepEquals(rows, expected),
    )
    expect(
      actual,
      `rows written per chunk attempt: ${JSON.stringify(writtenAttempts)} (${replicaVisibility.kind}, syncDenied=${syncReplicaDenied})`,
    ).toEqual(expected)
  }, 240_000)
})
