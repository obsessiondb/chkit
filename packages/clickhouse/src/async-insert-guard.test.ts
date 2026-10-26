import { describe, expect, test } from 'bun:test'

import { assertNoFireAndForgetAsyncInserts, fireAndForgetInsertsSql } from './async-insert-guard.js'
import type { ClickHouseExecutor } from './index.js'

// `rows` is what the query_log read returns; `replicas` what the fan-out probe counts.
function queryLogExecutor(rows: Array<{ table: string; inserts: number }> | Error, replicas = 1) {
  const queries: string[] = []
  const db = {
    async query<T>(sql: string): Promise<T[]> {
      queries.push(sql)
      if (sql.includes('system.one')) return [{ replicas }] as T[]
      if (rows instanceof Error) throw rows
      return rows as T[]
    },
  } as unknown as ClickHouseExecutor
  return { db, queries }
}

const EVENTS = [{ database: 'app', name: 'events' }]

describe('assertNoFireAndForgetAsyncInserts', () => {
  test('passes when no async insert with wait_for_async_insert = 0 reached the tables', async () => {
    const { db, queries } = queryLogExecutor([])
    await assertNoFireAndForgetAsyncInserts(db, EVENTS)
    expect(queries.at(-1)).toContain('FROM system.query_log WHERE')
  })

  test('refuses, naming the tables and counts, when one did', async () => {
    const { db } = queryLogExecutor([{ table: 'app.events', inserts: 12 }])
    await expect(assertNoFireAndForgetAsyncInserts(db, EVENTS)).rejects.toThrow(
      'ran in the last 10 minutes: 12 into app.events. ClickHouse drops the buffered rows'
    )
  })

  test('reads query_log on every replica, since an INSERT is logged where it ran', async () => {
    const { db, queries } = queryLogExecutor([], 2)
    await assertNoFireAndForgetAsyncInserts(db, EVENTS)
    expect(queries.at(-1)).toContain("FROM clusterAllReplicas('default', system.query_log) WHERE")
  })

  test('warns and goes on when query_log cannot be read', async () => {
    const { db } = queryLogExecutor(new Error('Not enough privileges'))
    const lines: string[] = []
    await assertNoFireAndForgetAsyncInserts(db, EVENTS, { log: (line) => lines.push(line) })
    expect(lines).toEqual([expect.stringContaining('could not read system.query_log')])
  })
})

describe('fireAndForgetInsertsSql', () => {
  test('counts only queries that went through the async queue, with the effective wait setting', () => {
    const sql = fireAndForgetInsertsSql('system.query_log', ['app.events', 'app.events__cutover_1'])
    expect(sql).toContain("ProfileEvents['AsyncInsertQuery'] > 0")
    expect(sql).toContain("hasAny(tables, ['app.events', 'app.events__cutover_1'])")
    // A setting missing from Settings has its built-in default (1 in open-source ClickHouse).
    expect(sql).toContain(
      "if(mapContains(Settings, 'wait_for_async_insert'), Settings['wait_for_async_insert'], (SELECT default FROM system.settings WHERE name = 'wait_for_async_insert')) IN ('0', 'false')"
    )
    expect(sql).toContain('event_time >= now() - INTERVAL 10 MINUTE')
  })
})
