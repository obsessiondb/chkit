import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { createClient } from '@clickhouse/client'
import { createLiveExecutor, getRequiredEnv } from '@chkit/clickhouse/e2e-testkit'
import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { analyzeAndChunk } from '../analyze.js'
import { buildChunkExecutionSql, buildWhereClauseFromChunk } from '../sql.js'
import type { Chunk, ChunkPlan, PlannerQuery } from '../types.js'

import { TABLE_PREFIX } from './constants.js'

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let executor: ClickHouseExecutor
let plannerQuery: PlannerQuery
let closePlannerClient: () => Promise<void>
let db: string

beforeAll(() => {
  const env = getRequiredEnv()
  executor = createLiveExecutor(env)
  db = env.clickhouseDatabase

  // The planner runs parallel queries via pMap, which requires a sessionless
  // client to avoid ClickHouse Cloud session locking errors.
  const client = createClient({
    url: env.clickhouseUrl,
    username: env.clickhouseUser,
    password: env.clickhousePassword,
    database: env.clickhouseDatabase,
    clickhouse_settings: { wait_end_of_query: 1 },
  })

  plannerQuery = async <T>(sql: string, settings?: Record<string, string | number | boolean | undefined>): Promise<T[]> => {
    const result = await client.query({
      query: sql,
      format: 'JSONEachRow',
      ...(settings ? { clickhouse_settings: settings } : {}),
    })
    return result.json<T>()
  }
  closePlannerClient = () => client.close()
})

afterAll(async () => {
  await closePlannerClient?.()
  await executor?.close()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function strategyIds(chunk: Chunk): string[] {
  return chunk.analysis.lineage.map((step) => step.strategyId)
}

async function requireSeededTable(table: string): Promise<number> {
  const [result] = await executor.query<{ cnt: string }>(
    `SELECT count() AS cnt FROM ${db}.${table} SETTINGS select_sequential_consistency = 1`,
  )
  const count = Number(result?.cnt ?? 0)
  if (count === 0) {
    throw new Error(
      `Table ${db}.${table} is empty. Run the seed script first:\n` +
      `  bun run seed:env`,
    )
  }
  return count
}

async function getPartitionUncompressedBytes(table: string): Promise<number> {
  const rows = await executor.query<{ total: string }>(`
    SELECT toString(sum(data_uncompressed_bytes)) AS total
    FROM system.parts
    WHERE database = '${db}' AND table = '${table}' AND active = 1
    SETTINGS select_sequential_consistency = 1
  `)
  return Number(rows[0]?.total ?? 0)
}

async function chunkPlan(table: string, targetChunkBytes: number): Promise<ChunkPlan> {
  return analyzeAndChunk({
    database: db,
    table,
    targetChunkBytes,
    query: plannerQuery,
    querySettings: { enable_parallel_replicas: 0 },
  })
}

function buildSql(plan: ChunkPlan, chunk: Chunk): string {
  return buildChunkExecutionSql({
    planId: plan.planId,
    chunk,
    target: `${plan.table.database}.${plan.table.table}`,
    sourceTarget: `${plan.table.database}.${plan.table.table}`,
    table: plan.table,
  })
}

// ---------------------------------------------------------------------------
// Scenario 1: Skewed Power Law Distribution
//
// 80% of rows belong to a single tenant ("mega-corp"), 20% spread across
// 200 small tenants. Sort key: (tenant_id, seq).
//
// Expected behavior:
//   - The system detects "mega-corp" as a hot key
//   - mega-corp chunks are split on the secondary dimension (seq)
//   - Small tenants are grouped into larger chunks
//   - All rows are covered, no gaps or overlaps
// ---------------------------------------------------------------------------

describe('e2e: skewed power law', () => {
  const table = `${TABLE_PREFIX}_skewed_power_law`
  let plan: ChunkPlan
  let totalRows: number

  beforeAll(async () => {
    totalRows = await requireSeededTable(table)
    const uncompressedBytes = await getPartitionUncompressedBytes(table)

    // Target ~5 chunks
    const targetChunkBytes = Math.floor(uncompressedBytes / 5)
    plan = await chunkPlan(table, targetChunkBytes)
  }, 60_000)

  test('produces multiple chunks', () => {
    expect(plan.chunks.length).toBeGreaterThan(1)
  })

  test('detects mega-corp as a focused (hot) key', () => {
    const focused = plan.chunks.filter(
      (c) => c.analysis.focusedValue?.value === 'mega-corp',
    )
    expect(focused.length).toBeGreaterThan(0)
  })

  test('mega-corp chunks are split on the secondary dimension (seq)', () => {
    const megaCorpChunks = plan.chunks.filter(
      (c) => c.analysis.focusedValue?.value === 'mega-corp',
    )
    expect(megaCorpChunks.length).toBeGreaterThan(1)

    // Each mega-corp chunk should have ranges on both dimensions
    for (const chunk of megaCorpChunks) {
      const dims = new Set(chunk.ranges.map((r) => r.dimensionIndex))
      expect(dims.has(0)).toBe(true) // tenant_id
      expect(dims.has(1)).toBe(true) // seq
    }
  })

  test('mega-corp chunk boundaries on dim 1 are contiguous', () => {
    const megaCorpChunks = plan.chunks
      .filter((c) => c.analysis.focusedValue?.value === 'mega-corp')
      .sort((a, b) => {
        const aFrom = a.ranges.find((r) => r.dimensionIndex === 1)?.from ?? ''
        const bFrom = b.ranges.find((r) => r.dimensionIndex === 1)?.from ?? ''
        return String(aFrom).localeCompare(String(bFrom))
      })

    for (let i = 1; i < megaCorpChunks.length; i++) {
      const prev = megaCorpChunks[i - 1]?.ranges.find((r) => r.dimensionIndex === 1)
      const curr = megaCorpChunks[i]?.ranges.find((r) => r.dimensionIndex === 1)
      if (prev?.to !== undefined && curr?.from !== undefined) {
        expect(prev.to).toBe(curr.from)
      }
    }
  })

  test('estimated row sum is within 20% of actual count', () => {
    const estimatedTotal = plan.chunks.reduce((sum, c) => sum + c.estimate.rows, 0)
    const ratio = estimatedTotal / totalRows
    expect(ratio).toBeGreaterThanOrEqual(0.8)
    expect(ratio).toBeLessThanOrEqual(1.2)
  })

  test('no chunk exceeds 2x the target size', () => {
    for (const chunk of plan.chunks) {
      expect(chunk.estimate.bytesUncompressed).toBeLessThan(plan.targetChunkBytes * 2)
    }
  })

  test('every chunk produces valid execution SQL', () => {
    for (const chunk of plan.chunks) {
      const sql = buildSql(plan, chunk)
      expect(sql).toContain('INSERT INTO')
      expect(sql).toContain('_partition_id')
      // mega-corp chunks should reference both sort key columns
      if (chunk.analysis.focusedValue?.value === 'mega-corp') {
        expect(sql).toContain('tenant_id >=')
        expect(sql).toContain('seq >=')
      }
    }
  })

  test('executing all chunk queries returns the full row count', async () => {
    let totalCounted = 0
    for (const chunk of plan.chunks) {
      const where = buildWhereClauseFromChunk(chunk, plan.table)
      const countSql = `SELECT count() AS cnt FROM ${db}.${table} WHERE ${where}`
      const [row] = await executor.query<{ cnt: string }>(countSql)
      totalCounted += Number(row?.cnt ?? 0)
    }

    expect(totalCounted).toBe(totalRows)
  }, 60_000)
})
