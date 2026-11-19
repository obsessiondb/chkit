import pMap from 'p-map'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  createLiveExecutor,
  createPrefix,
  createStatelessLiveExecutor,
  getLiveEnv,
  pollUntil,
  waitForTable,
} from '@chkit/clickhouse/e2e-testkit'
import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { generateChunkPlan } from '../planner.js'
import { buildWhereClauseFromChunk } from '../sql.js'
import type { ChunkPlan } from '../types.js'

// Coverage invariant (chkit#826): every source row matches exactly one chunk,
// read through the SQL the run executes. A numeric bound rendered as a string
// literal equal to the partition id ('3' in `_partition_id = '3' AND id >= '3'`)
// made ClickHouse's analyzer derive a string comparison on `_partition_id`, so
// the planner dropped ranges it counted as empty and the run copied 0 rows for
// chunks it kept.

interface Layout {
  name: string
  columns: string
  engine: string
  insert: string
  targetChunkBytes: number
}

const LAYOUTS: Layout[] = [
  {
    name: 'partition id equal to the lowest sort key of the partition',
    columns: 'id UInt64, p UInt8, s String',
    engine: 'PARTITION BY p ORDER BY id',
    insert: "SELECT number, number % 8, repeat('x', 200) FROM numbers(80000)",
    targetChunkBytes: 700_000,
  },
  {
    name: 'partition key is the leading sort key',
    columns: 'tenant UInt32, id UInt64, s String',
    engine: 'PARTITION BY tenant ORDER BY (tenant, id)',
    insert: "SELECT number % 12, number, repeat('x', 200) FROM numbers(60000)",
    targetChunkBytes: 400_000,
  },
  {
    name: 'signed key partitioned by its sign',
    columns: 'id Int64, s String',
    engine: 'PARTITION BY id < 0 ORDER BY id',
    insert: "SELECT toInt64(number) - 20000, repeat('x', 200) FROM numbers(40000)",
    targetChunkBytes: 1_000_000,
  },
  {
    name: 'unpartitioned numeric key',
    columns: 'id UInt64, s String',
    engine: 'ORDER BY id',
    insert: "SELECT number, repeat('x', 200) FROM numbers(40000)",
    targetChunkBytes: 1_000_000,
  },
  {
    name: 'monthly partitions on a datetime key',
    columns: 'ts DateTime, id UInt64, s String',
    engine: 'PARTITION BY toYYYYMM(ts) ORDER BY (ts, id)',
    insert: "SELECT toDateTime('2026-01-01 00:00:00') + number * 120, number, repeat('x', 200) FROM numbers(60000)",
    targetChunkBytes: 1_000_000,
  },
  {
    name: 'string key partitioned by a digit',
    columns: 'k String, p UInt8, s String',
    engine: 'PARTITION BY p ORDER BY k',
    insert: "SELECT toString(number), number % 4, repeat('x', 200) FROM numbers(20000)",
    targetChunkBytes: 500_000,
  },
]

let executor: ClickHouseExecutor
let plannerExecutor: ClickHouseExecutor
let db: string
const tables: string[] = []

beforeAll(() => {
  const env = getLiveEnv()
  executor = createLiveExecutor(env)
  // The planner and the per-chunk counts run parallel queries, which need a
  // sessionless client.
  plannerExecutor = createStatelessLiveExecutor(env)
  db = env.clickhouseDatabase
})

afterAll(async () => {
  for (const table of tables) await executor.command(`DROP TABLE IF EXISTS ${db}.${table}`)
  await plannerExecutor?.close()
  await executor?.close()
})

async function countRows(sql: string): Promise<number> {
  const [row] = await plannerExecutor.query<{ cnt: string }>(`${sql} SETTINGS select_sequential_consistency = 1`)
  return Number(row?.cnt ?? 0)
}

async function createLayoutTable(layout: Layout): Promise<{ table: string; totalRows: number }> {
  const table = `${createPrefix('backfill_coverage')}t`
  tables.push(table)
  await executor.command(`CREATE TABLE ${db}.${table} (${layout.columns}) ENGINE = MergeTree ${layout.engine}`)
  await waitForTable(executor, db, table)
  await executor.command(`INSERT INTO ${db}.${table} ${layout.insert}`)
  const [expected] = await executor.query<{ cnt: string }>(`SELECT count() AS cnt FROM (${layout.insert})`)
  const totalRows = Number(expected?.cnt ?? 0)
  await pollUntil(
    () => countRows(`SELECT count() AS cnt FROM ${db}.${table}`),
    (count) => count === totalRows,
  )
  return { table, totalRows }
}

describe('e2e: chunk plans cover every source row exactly once (chkit#826)', () => {
  for (const layout of LAYOUTS) {
    test(layout.name, async () => {
      const { table, totalRows } = await createLayoutTable(layout)
      const plan: ChunkPlan = await generateChunkPlan({
        database: db,
        table,
        targetChunkBytes: layout.targetChunkBytes,
        query: (sql, settings) => plannerExecutor.query(sql, settings),
        querySettings: { enable_parallel_replicas: 0 },
      })
      expect(plan.chunks.length).toBeGreaterThan(1)

      const predicates = plan.chunks.map((chunk) => buildWhereClauseFromChunk(chunk, plan.table))
      // Each chunk counted through its own WHERE, as the run's INSERT ... SELECT reads it.
      const perChunk = await pMap(
        predicates,
        (where) => countRows(`SELECT count() AS cnt FROM ${db}.${table} WHERE ${where}`),
        { concurrency: 10 },
      )
      expect(perChunk.reduce((sum, rows) => sum + rows, 0)).toBe(totalRows)

      const matches = predicates.map((where) => `toUInt32(${where.replace(/\n/g, ' ')})`).join(' + ')
      const notExactlyOnce = await countRows(
        `SELECT countIf(matches != 1) AS cnt FROM (SELECT ${matches} AS matches FROM ${db}.${table})`,
      )
      expect(notExactlyOnce).toBe(0)
    }, 120_000)
  }
})
