import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createClient } from '@clickhouse/client'
import { createPrefix, createStatelessLiveExecutor, LOCAL_STACK_ENV, quoteIdent, waitForTable } from '@chkit/clickhouse/e2e-testkit'
import { type QueryClient, toCreateSQL } from '@chkit/core'

import { type ChkitSide, compareParity, type OracleSnapshot } from '../parity/compare.js'
import { renderEndpointSql } from '../parity/endpoint-render.js'
import recorded from '../test/fixtures/synthetic.oracle.json'
import { importTinybirdProject, type TinybirdImport } from './index.js'

// The oracle (DDL, copy schedules, resolved SELECTs and endpoint renders) was
// recorded from Tinybird Local with `bun run parity -- --project
// test/fixtures/synthetic --record test/fixtures/synthetic.oracle.json`.
// Tinybird runs on plain ClickHouse, so this always targets the local test
// stack, also when the rest of the suite targets ObsessionDB (whose Shared
// engines are not what Tinybird creates), as plugin-ingest's staged-loader
// E2Es do.
const FIXTURE = join(import.meta.dir, '../test/fixtures/synthetic')
// The generated queries import '@chkit/core', which does not resolve from a temp dir.
const CORE_ENTRY = join(import.meta.dir, '../../core/src/index.ts')
const oracle = recorded as OracleSnapshot
const executor = createStatelessLiveExecutor(LOCAL_STACK_ENV)
const client = createClient({
  url: LOCAL_STACK_ENV.clickhouseUrl,
  username: LOCAL_STACK_ENV.clickhouseUser,
  password: LOCAL_STACK_ENV.clickhousePassword,
})
const database = `${createPrefix('tinybird')}import`
const dirs: string[] = []

afterAll(async () => {
  await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
  await executor.close()
  await client.close()
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('@chkit/plugin-tinybird fixture parity (test stack)', () => {
  test('the imported schema creates the objects Tinybird created, and its queries run', async () => {
    const imported = await importTinybirdProject({ projectDir: FIXTURE, database })
    await executor.command(`CREATE DATABASE ${quoteIdent(database)}`)
    // Tables before views; refreshable views after the tables they read.
    const ordered = [...imported.definitions].sort((a, b) => Number(a.kind !== 'table') - Number(b.kind !== 'table'))
    for (const definition of ordered) {
      await executor.command(toCreateSQL(definition))
      await waitForTable(executor, database, definition.name)
    }

    const entries = await compareParity(oracle, await readChkitSide(imported), imported.report, {
      formatQuery: async (sql) => {
        const [row] = await executor.query<{ q: string }>(`SELECT formatQuerySingleLine(${stringLiteral(sql)}) AS q`)
        return row?.q ?? ''
      },
    })

    expect(entries.filter((entry) => entry.status === 'different')).toEqual([])
    expect(entries.filter((entry) => entry.status === 'untranslatable').map((entry) => `${entry.kind}:${entry.name}`).sort()).toEqual([
      'copy:type_totals_business_hours',
      'copy:type_totals_manual',
      'datasource:sampled',
      'endpoint:top_users',
    ])
    expect(entries.filter((entry) => entry.status === 'equal').map((entry) => entry.kind).sort()).toEqual([
      ...Array(5).fill('copy'),
      ...Array(11).fill('datasource'),
      ...Array(3).fill('endpoint'),
      ...Array(4).fill('materialized'),
    ])

    // The generated module compiles, and every query runs with each param set.
    const dir = await mkdtemp(join(tmpdir(), 'chkit-tinybird-queries-'))
    dirs.push(dir)
    const file = join(dir, 'queries.ts')
    await writeFile(file, (imported.queriesSource ?? '').replace("from '@chkit/core'", `from ${JSON.stringify(CORE_ENTRY)}`))
    const queries: Record<string, (params: Record<string, unknown>, options: { client: QueryClient }) => Promise<unknown[]>> = await import(
      pathToFileURL(file).href
    )
    expect(imported.endpoints.map((endpoint) => endpoint.exportName).sort()).toEqual(['events_by_type', 'flagged_users', 'static_counts'])
    for (const endpoint of imported.endpoints) {
      const run = queries[endpoint.exportName]
      expect(typeof run).toBe('function')
      for (const params of endpoint.paramSets) {
        const values = Object.fromEntries(
          Object.entries(params).map(([name, value]) => [name, /Int|Float/.test(endpoint.params.find((param) => param.name === name)?.type ?? '') ? Number(value) : value])
        )
        expect(await run?.(values, { client })).toEqual([])
      }
    }
  }, 120_000)
})

async function readChkitSide(imported: TinybirdImport): Promise<ChkitSide> {
  const [server] = await executor.query<{ version: string; timezone: string }>('SELECT version() AS version, timezone() AS timezone')
  const rows = await executor.query<{ name: string; create_table_query: string; as_select: string; created: string }>(
    `SELECT name, create_table_query, as_select, toString(metadata_modification_time) AS created FROM system.tables WHERE database = ${stringLiteral(database)}`
  )
  const refreshes = await executor.query<{ view: string; next: string }>(
    `SELECT view, toString(next_refresh_time) AS next FROM system.view_refreshes WHERE database = ${stringLiteral(database)}`
  )
  return {
    database,
    clickhouseVersion: server?.version ?? '',
    serverTimezone: server?.timezone ?? '',
    objects: new Map(rows.map((row) => [row.name, { createTableQuery: row.create_table_query, asSelect: row.as_select, createdAt: row.created }])),
    refreshes: new Map(refreshes.map((row) => [row.view, { nextRefreshTime: row.next }])),
    endpoints: new Map(imported.endpoints.map((endpoint) => [endpoint.pipe, endpoint.paramSets.map((params) => ({ params, sql: renderEndpointSql(endpoint, params) }))])),
  }
}

function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
