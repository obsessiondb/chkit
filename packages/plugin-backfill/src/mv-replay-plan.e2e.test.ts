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
  getRequiredEnv,
  waitForTable,
} from '@chkit/clickhouse/e2e-testkit'

import { executeBackfill } from './async-backfill.js'
import { buildChunkExecutionSql } from './chunking/sql.js'
import { generateIdempotencyToken } from './chunking/utils/ids.js'
import { PlanSchema } from './options.js'
import { buildBackfillPlan } from './planner.js'
import type { PlannerQuery } from './chunking/types.js'
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

// DDL / inserts / counts go through the session-bound executor (sequential).
let ddl: ClickHouseExecutor
// The execute loop submits + polls in parallel; a stateless executor avoids
// ObsessionDB session-locking errors under concurrency.
let runExecutor: ClickHouseExecutor
let plannerQuery: PlannerQuery
let db: string
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
  const env = getRequiredEnv()
  db = env.clickhouseDatabase
  ddl = createLiveExecutor(env)
  runExecutor = createStatelessLiveExecutor(env)
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

    const result = await executeBackfill({
      executor: runExecutor,
      planId: plan.planId,
      chunks: plan.chunkPlan.chunks.map((chunk) => ({ id: chunk.id })),
      buildQuery: ({ id }) => {
        const planChunk = plan.chunkPlan.chunks.find((candidate) => candidate.id === id)
        if (!planChunk) throw new Error(`Chunk ${id} not found in plan`)
        return buildChunkExecutionSql({
          planId: plan.planId,
          chunk: planChunk,
          target: plan.target,
          sourceTarget: plan.execution.sourceTarget,
          table: plan.chunkPlan.table,
          mvReplayQueries: plan.execution.mvReplayQueries,
          targetColumns: plan.execution.targetColumns,
          idempotencyToken: plan.execution.requireIdempotencyToken
            ? generateIdempotencyToken(plan.planId, planChunk.id)
            : '',
        })
      },
      concurrency: 3,
      pollIntervalMs: 1500,
    })

    expect(result.failed).toBe(0)
    expect(result.completed).toBe(plan.chunkPlan.chunks.length)

    // Per-bucket values must match a forward run of the MV over the whole source.
    const expected = await aggregateByBucket(sourceFqn, 'sum(id)')
    const actual = await aggregateByBucket(targetFqn, 'sum(total)')
    expect(expected).toHaveLength(BUCKETS)
    expect(actual).toEqual(expected)
  }, 180_000)
})
