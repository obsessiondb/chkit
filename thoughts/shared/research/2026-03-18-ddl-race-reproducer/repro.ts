/**
 * Reproduces the DDL race condition on distributed ClickHouse.
 *
 * Creates a table then immediately creates a materialized view referencing it.
 * Without session affinity or DDL propagation wait, the MV creation can fail
 * because the table isn't visible on the node that receives the MV DDL.
 *
 * Usage:
 *   CLICKHOUSE_HOST=... CLICKHOUSE_PASSWORD=... bun run repro.ts
 */

import { resolve } from 'node:path'

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../../..')
const { createClickHouseExecutor } = await import(
  `${WORKSPACE_ROOT}/packages/clickhouse/src/index.js`
)

const host = process.env.CLICKHOUSE_HOST ?? 'customer-benchmark.eu-central.obsessiondb.com'
const password = process.env.CLICKHOUSE_PASSWORD
const database = process.env.CLICKHOUSE_DB ?? 'default'
const ATTEMPTS = Number(process.env.ATTEMPTS ?? '20')

if (!password) {
  console.error('CLICKHOUSE_PASSWORD is required')
  process.exit(1)
}

const executor = createClickHouseExecutor({
  url: `https://${host}:8443`,
  username: 'default',
  password,
  database,
})

let failures = 0
let successes = 0

for (let i = 0; i < ATTEMPTS; i++) {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`
  const tableName = `_ddl_race_events_${suffix}`
  const targetName = `_ddl_race_counts_${suffix}`
  const mvName = `_ddl_race_counts_mv_${suffix}`

  try {
    await executor.execute(`
      CREATE TABLE ${database}.${tableName} (
        id UInt64,
        org_id String,
        received_at DateTime64(3)
      ) ENGINE = MergeTree()
      PRIMARY KEY (org_id)
      ORDER BY (org_id, received_at, id)
    `)

    await executor.execute(`
      CREATE TABLE ${database}.${targetName} (
        org_id String,
        total UInt64
      ) ENGINE = SummingMergeTree()
      PRIMARY KEY (org_id)
      ORDER BY (org_id)
    `)

    // Immediately create MV referencing the tables — no wait
    await executor.execute(`
      CREATE MATERIALIZED VIEW ${database}.${mvName}
      TO ${database}.${targetName}
      AS SELECT org_id, count() AS total
      FROM ${database}.${tableName}
      GROUP BY org_id
    `)

    successes++
    console.log(`[${i + 1}/${ATTEMPTS}] OK`)
  } catch (error) {
    failures++
    const msg = error instanceof Error ? error.message : String(error)
    console.log(`[${i + 1}/${ATTEMPTS}] FAILED: ${msg}`)
  } finally {
    try { await executor.execute(`DROP VIEW IF EXISTS ${database}.${mvName}`) } catch {}
    try { await executor.execute(`DROP TABLE IF EXISTS ${database}.${targetName}`) } catch {}
    try { await executor.execute(`DROP TABLE IF EXISTS ${database}.${tableName}`) } catch {}
  }
}

console.log(`\nResults: ${successes} succeeded, ${failures} failed out of ${ATTEMPTS}`)
await executor.close()
process.exit(failures > 0 ? 1 : 0)
