import { afterAll, describe, expect, test } from 'bun:test'

import {
  createLiveExecutor,
  createPrefix,
  getLiveEnv,
  pollUntil,
  waitForTable,
} from '@chkit/clickhouse/e2e-testkit'

import type { PlannerContext } from '../types.js'
import { introspectPartitions } from './metadata-source.js'

// Regression e2e for chkit#320: a part whose min/max index is empty reports
// min_time = 1970-01-01 in system.parts. It must not pull its partition into
// every --from/--to window.

const env = getLiveEnv()
const db = env.clickhouseDatabase
const executor = createLiveExecutor(env)
const table = `${createPrefix('backfill_epoch_parts')}events`
const fqn = `${db}.${table}`

afterAll(async () => {
  await executor.command(`DROP TABLE IF EXISTS ${fqn}`)
  await executor.close()
})

function plannerContext(from: string, to: string): PlannerContext {
  return {
    database: db,
    table,
    from,
    to,
    targetChunkBytes: 1024 ** 3,
    query: (sql, settings) => executor.query(sql, settings),
    rowProbeStrategy: 'count',
  }
}

describe('e2e: introspectPartitions --from/--to window (chkit#320)', () => {
  test('a zero min_time part does not widen its partition into the window', async () => {
    // remove_empty_parts = 0 keeps the empty part a DELETE mutation leaves behind,
    // which background cleanup would otherwise drop at an unpredictable time.
    await executor.command(`
      CREATE TABLE ${fqn} (id UInt64, t DateTime)
      ENGINE = MergeTree
      PARTITION BY toYYYYMM(t)
      ORDER BY (t, id)
      SETTINGS remove_empty_parts = 0
    `)
    await waitForTable(executor, db, table)
    await executor.command(`INSERT INTO ${fqn} SELECT number, toDateTime('2020-10-05 00:00:00') + number * 60 FROM numbers(100)`)
    await executor.command(`INSERT INTO ${fqn} SELECT number, toDateTime('2026-10-01 00:00:00') + number * 60 FROM numbers(100)`)
    await executor.command(`INSERT INTO ${fqn} SELECT number, toDateTime('2026-10-20 00:00:00') + number * 60 FROM numbers(100)`)
    await executor.command(`ALTER TABLE ${fqn} DELETE WHERE t >= '2026-10-20 00:00:00' SETTINGS mutations_sync = 2`)

    const zeroParts = await pollUntil(
      () => executor.query<{ partition_id: string }>(`
        SELECT partition_id
        FROM system.parts
        WHERE database = '${db}' AND table = '${table}' AND active = 1 AND min_time = 0
        SETTINGS select_sequential_consistency = 1
      `),
      (rows) => rows.length > 0,
    )
    expect(zeroParts.map((row) => row.partition_id)).toEqual(['202610'])

    const october2020 = await introspectPartitions(plannerContext('2020-10-01T00:00:00.000Z', '2020-11-01T00:00:00.000Z'))
    expect(october2020.map((partition) => partition.partitionId)).toEqual(['202010'])

    const october2026 = await introspectPartitions(plannerContext('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'))
    expect(october2026.map((partition) => [partition.partitionId, partition.minTime])).toEqual([
      ['202610', '2026-10-01T00:00:00.000Z'],
    ])
  }, 60_000)
})
