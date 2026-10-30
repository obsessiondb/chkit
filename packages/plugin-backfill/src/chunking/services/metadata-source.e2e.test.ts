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
const dateTable = `${createPrefix('backfill_date_parts')}events`
const dateFqn = `${db}.${dateTable}`

afterAll(async () => {
  await executor.command(`DROP TABLE IF EXISTS ${fqn}`)
  await executor.command(`DROP TABLE IF EXISTS ${dateFqn}`)
  await executor.close()
})

function plannerContext(from: string, to: string, tableName = table): PlannerContext {
  return {
    database: db,
    table: tableName,
    from,
    to,
    targetChunkBytes: 1024 ** 3,
    query: (sql, settings) => executor.query(sql, settings),
    rowProbeStrategy: 'count',
  }
}

describe('e2e: introspectPartitions --from/--to window (chkit#320, chkit#352)', () => {
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

  // chkit#352: for a Date partition column system.parts reports min_time = max_time
  // = 1970-01-01 and fills min_date/max_date instead.
  test('a Date partition column windows by min_date/max_date', async () => {
    await executor.command(`
      CREATE TABLE ${dateFqn} (id UInt64, d Date)
      ENGINE = MergeTree
      PARTITION BY toYYYYMM(d)
      ORDER BY (d, id)
      SETTINGS remove_empty_parts = 0
    `)
    await waitForTable(executor, db, dateTable)
    await executor.command(`INSERT INTO ${dateFqn} SELECT number, toDate('2026-08-01') + number FROM numbers(70)`)
    await executor.command(`INSERT INTO ${dateFqn} SELECT number, toDate('2026-09-20') FROM numbers(10)`)
    await executor.command(`ALTER TABLE ${dateFqn} DELETE WHERE d = '2026-09-20' SETTINGS mutations_sync = 2`)

    const parts = await pollUntil(
      () => executor.query<{ partition_id: string; min_time: string; min_date: string }>(`
        SELECT partition_id, toString(min(min_time)) AS min_time, toString(min(min_date)) AS min_date
        FROM system.parts
        WHERE database = '${db}' AND table = '${dateTable}' AND active = 1
        GROUP BY partition_id
        ORDER BY partition_id
        SETTINGS select_sequential_consistency = 1
      `),
      (rows) => rows.length === 3 && rows[1]?.min_date === '1970-01-01',
    )
    expect(parts).toEqual([
      { partition_id: '202608', min_time: '1970-01-01 00:00:00', min_date: '2026-08-01' },
      { partition_id: '202609', min_time: '1970-01-01 00:00:00', min_date: '1970-01-01' },
      { partition_id: '202610', min_time: '1970-01-01 00:00:00', min_date: '2026-10-01' },
    ])

    const september = await introspectPartitions(
      plannerContext('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', dateTable),
    )
    expect(september.map((partition) => [partition.partitionId, partition.minTime, partition.maxTime])).toEqual([
      ['202609', '2026-09-01T00:00:00.000Z', '2026-09-30T23:59:59.000Z'],
    ])

    const lastDayOfAugust = await introspectPartitions(
      plannerContext('2026-08-31T12:00:00.000Z', '2026-09-01T00:00:00.000Z', dateTable),
    )
    expect(lastDayOfAugust.map((partition) => partition.partitionId)).toEqual(['202608'])
  }, 60_000)
})
