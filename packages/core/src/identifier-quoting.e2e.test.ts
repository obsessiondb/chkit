/**
 * Live round-trip for identifier quoting.
 *
 * Executes chkit-generated DDL whose table and column names contain characters
 * a source catalog (e.g. Postgres via CDC) may legally use, then reads the names
 * back from system tables to prove ClickHouse stored exactly what was declared.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createClient } from '@clickhouse/client'

import { table } from './model.js'
import { planDiff } from './planner.js'
import { renderAlterAddColumn, renderAlterDropColumn, toCreateSQL } from './sql.js'

// Same target rules as getLiveEnv in @chkit/clickhouse/e2e-testkit, which core
// cannot depend on: without CLICKHOUSE_URL or CLICKHOUSE_HOST, use the local
// test stack (test/infra).
function getLiveEnv() {
  const host = process.env.CLICKHOUSE_HOST?.trim()
  const url = process.env.CLICKHOUSE_URL?.trim() || (host ? `https://${host}` : '')
  if (!url) {
    return { url: `http://localhost:${process.env.CHKIT_TEST_PORT?.trim() || '8123'}`, username: 'default', password: 'chkit-ci', database: 'default' }
  }
  const username = process.env.CLICKHOUSE_USER?.trim() || 'default'
  const password = process.env.CLICKHOUSE_PASSWORD?.trim() || ''
  const database = process.env.CLICKHOUSE_DB?.trim() || 'default'

  if (!password) throw new Error('Missing CLICKHOUSE_PASSWORD')

  return { url, username, password, database }
}

const env = getLiveEnv()
const client = createClient({
  url: env.url,
  username: env.username,
  password: env.password,
  database: env.database,
  clickhouse_settings: { wait_end_of_query: 1 },
})

const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`
const tableName = `chkit_e2e_ident.${suffix} we\`ird\\name`
const evilColumn = 'evil` UInt8, `x'

const def = table({
  database: env.database,
  name: tableName,
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: evilColumn, type: 'String' },
    { name: 'a.b', type: 'String' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})

async function exec(sql: string): Promise<void> {
  await client.command({ query: sql })
}

// ObsessionDB exposes its replicas as the `default` cluster, and each request
// lands on any of them. An ALTER that runs on a replica that has not applied
// the previous DDL writes back its stale schema and loses that change (#709),
// so the names are read on every replica: one list per replica with the table.
let replicas = 0
const onEveryReplica = (names: string[]) => Array.from({ length: replicas }, () => names)

async function readColumnNames(): Promise<string[][]> {
  const rs = await client.query({
    query: `SELECT hostName() AS replica, name FROM clusterAllReplicas('default', system.columns)
      WHERE database = {db:String} AND table = {table:String} ORDER BY replica, position`,
    query_params: { db: env.database, table: tableName },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ replica: string; name: string }>()
  return [...new Set(rows.map((row) => row.replica))].map((replica) =>
    rows.filter((row) => row.replica === replica).map((row) => row.name),
  )
}

// ObsessionDB DDL is eventually consistent: re-read until the expected shape
// appears, then let the caller's expect report the real diff on timeout.
// Each test outlives its polls, so bun's 5s default never cuts one short.
const POLL_DEADLINE_MS = 30_000
const POLL_TEST_TIMEOUT_MS = POLL_DEADLINE_MS + 15_000
async function pollColumnNames(expected: string[][]): Promise<string[][]> {
  const deadline = Date.now() + POLL_DEADLINE_MS
  for (;;) {
    const names = await readColumnNames()
    if (JSON.stringify(names) === JSON.stringify(expected) || Date.now() >= deadline) return names
    await sleep(500)
  }
}

describe('identifier quoting round-trips through live ClickHouse', () => {
  beforeAll(async () => {
    const rs = await client.query({
      query: "SELECT toUInt32(count(DISTINCT hostName())) AS n FROM clusterAllReplicas('default', system.one)",
      format: 'JSONEachRow',
    })
    replicas = (await rs.json<{ n: number }>())[0]?.n ?? 0
  })

  afterAll(async () => {
    const [drop] = planDiff([def], []).operations
    if (drop) await exec(drop.sql.replace(/;$/, ''))
    await client.close()
  })

  test('CREATE TABLE preserves table and column names verbatim', async () => {
    await exec(toCreateSQL(def).replace(/;$/, ''))
    const created = onEveryReplica(['id', evilColumn, 'a.b'])
    expect(await pollColumnNames(created)).toEqual(created)
  }, POLL_TEST_TIMEOUT_MS)

  test('ADD COLUMN and DROP COLUMN target the exact names', async () => {
    const added = 'new`col\\with slash'
    await exec(renderAlterAddColumn(def, { name: added, type: 'String' }).replace(/;$/, ''))
    const withAdded = onEveryReplica(['id', evilColumn, 'a.b', added])
    expect(await pollColumnNames(withAdded)).toEqual(withAdded)

    await exec(renderAlterDropColumn(def, evilColumn).replace(/;$/, ''))
    const withoutDropped = onEveryReplica(['id', 'a.b', added])
    expect(await pollColumnNames(withoutDropped)).toEqual(withoutDropped)
  }, 2 * POLL_TEST_TIMEOUT_MS)
})
