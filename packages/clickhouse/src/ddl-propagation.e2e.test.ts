import { describe, expect, test } from 'bun:test'

import { waitForDDLPropagation } from './ddl-propagation.js'
import { createLiveExecutor, createPrefix, getLiveEnv, quoteIdent, waitForTable } from './e2e-testkit.js'
import type { ClickHouseExecutor, ClickHouseSettings } from './index.js'
import { allReplicas, resolveReplicaFanout } from './replicas.js'

/**
 * `migrate` calls waitForDDLPropagation after every statement. On managed
 * ClickHouse (e.g. ObsessionDB) DDL propagates asynchronously, so creating a
 * view that reads another view only succeeds reliably once the first CREATE
 * is visible (#231). The executor is live; the wrapper only records the
 * polling queries.
 */
describe('@chkit/clickhouse waitForDDLPropagation e2e', () => {
  test('waits for created views and materialized views to appear and dropped ones to disappear', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const db = liveEnv.clickhouseDatabase
    const p = createPrefix('ddlwait')
    const source = `${p}src`
    const target = `${p}dst`
    const view = `${p}v`
    const materializedView = `${p}mv`
    const object = (name: string) => `${quoteIdent(db)}.${quoteIdent(name)}`
    const { pollingQueries, listed, listedAsView, columnListed } = await recordPollingQueries(executor)

    try {
      await executor.command(`CREATE TABLE ${object(source)} (id UInt64) ENGINE = MergeTree ORDER BY id`)
      await executor.command(`CREATE TABLE ${object(target)} (id UInt64) ENGINE = MergeTree ORDER BY id`)
      await waitForTable(executor, db, source)
      await waitForTable(executor, db, target)

      await executor.command(`CREATE VIEW ${object(view)} AS SELECT id FROM ${object(source)}`)
      expect(await pollingQueries('create_view', `view:${db}.${view}`)).toEqual([listedAsView(db, view)])

      await executor.command(
        `CREATE MATERIALIZED VIEW ${object(materializedView)} TO ${object(target)} AS SELECT id FROM ${object(source)}`
      )
      expect(await pollingQueries('create_materialized_view', `materialized_view:${db}.${materializedView}`)).toEqual([
        listedAsView(db, materializedView),
      ])
      // MODIFY REFRESH keys carry a suffix; the wait checks the view still exists.
      expect(
        await pollingQueries('alter_materialized_view_modify_refresh', `materialized_view:${db}.${materializedView}:refresh`)
      ).toEqual([listed(db, materializedView)])

      await executor.command(`DROP VIEW ${object(view)}`)
      expect(await pollingQueries('drop_view', `view:${db}.${view}`)).toEqual([listed(db, view)])
      await executor.command(`DROP VIEW ${object(materializedView)}`)
      expect(await pollingQueries('drop_materialized_view', `materialized_view:${db}.${materializedView}`)).toEqual([
        listed(db, materializedView),
      ])
    } finally {
      await executor.command(`DROP VIEW IF EXISTS ${object(view)}`)
      await executor.command(`DROP VIEW IF EXISTS ${object(materializedView)}`)
      await executor.command(`DROP TABLE IF EXISTS ${object(source)}`)
      await executor.command(`DROP TABLE IF EXISTS ${object(target)}`)
      await executor.close()
    }
  }, 120_000)

  test('waits for objects and columns whose names contain quotes and backslashes', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const db = liveEnv.clickhouseDatabase
    const p = createPrefix('ddlwait_quoted')
    const table = `${p}o'brien\\t`
    const view = `${p}o'brien\\v`
    const column = `it's\\c`
    const object = (name: string) => `${quoteIdent(db)}.${quoteIdent(name)}`
    const wait = (operationType: string, operationKey: string) =>
      expect(waitForDDLPropagation(executor, operationType, operationKey)).resolves.toBeUndefined()

    try {
      await executor.command(`CREATE TABLE ${object(table)} (id UInt64) ENGINE = MergeTree ORDER BY id`)
      await wait('create_table', `table:${db}.${table}`)
      await executor.command(`ALTER TABLE ${object(table)} ADD COLUMN ${quoteIdent(column)} String`)
      await wait('alter_table_add_column', `table:${db}.${table}:column:${column}`)
      await executor.command(`CREATE VIEW ${object(view)} AS SELECT id FROM ${object(table)}`)
      await wait('create_view', `view:${db}.${view}`)
      await executor.command(`DROP VIEW ${object(view)}`)
      await wait('drop_view', `view:${db}.${view}`)
    } finally {
      await executor.command(`DROP VIEW IF EXISTS ${object(view)}`)
      await executor.command(`DROP TABLE IF EXISTS ${object(table)}`)
      await executor.close()
    }
  }, 120_000)

  test('waits for the whole name of objects and columns whose names contain colons', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const db = liveEnv.clickhouseDatabase
    const p = createPrefix('ddlwait_colon')
    const table = `${p}t:1`
    const target = `${p}dst`
    const column = 'c:1'
    const view = `${p}v:1`
    // Ends like a MODIFY REFRESH key, so only the key's last `:refresh` is cut.
    const materializedView = `${p}mv:refresh`
    const object = (name: string) => `${quoteIdent(db)}.${quoteIdent(name)}`
    const { pollingQueries, listed, listedAsView, columnListed } = await recordPollingQueries(executor)

    try {
      await executor.command(`CREATE TABLE ${object(table)} (id UInt64) ENGINE = MergeTree ORDER BY id`)
      expect(await pollingQueries('create_table', `table:${db}.${table}`)).toEqual([listed(db, table)])
      await executor.command(`ALTER TABLE ${object(table)} ADD COLUMN ${quoteIdent(column)} String`)
      expect(await pollingQueries('alter_table_add_column', `table:${db}.${table}:column:${column}`)).toEqual([
        columnListed(db, table, column),
      ])
      // Other ALTER keys carry a suffix too; the wait checks the table still exists.
      expect(await pollingQueries('alter_table_add_index', `table:${db}.${table}:index:i:1`)).toEqual([
        listed(db, table),
      ])

      await executor.command(`CREATE TABLE ${object(target)} (id UInt64) ENGINE = MergeTree ORDER BY id`)
      await waitForTable(executor, db, target)
      await executor.command(`CREATE VIEW ${object(view)} AS SELECT id FROM ${object(table)}`)
      expect(await pollingQueries('create_view', `view:${db}.${view}`)).toEqual([listedAsView(db, view)])
      await executor.command(
        `CREATE MATERIALIZED VIEW ${object(materializedView)} TO ${object(target)} AS SELECT id FROM ${object(table)}`
      )
      expect(await pollingQueries('create_materialized_view', `materialized_view:${db}.${materializedView}`)).toEqual([
        listedAsView(db, materializedView),
      ])
      expect(
        await pollingQueries('alter_materialized_view_modify_refresh', `materialized_view:${db}.${materializedView}:refresh`)
      ).toEqual([listed(db, materializedView)])

      // A drop wait that polled a shortened name would pass without waiting.
      await executor.command(`DROP VIEW ${object(view)}`)
      expect(await pollingQueries('drop_view', `view:${db}.${view}`)).toEqual([listed(db, view)])
      await executor.command(`DROP VIEW ${object(materializedView)}`)
      expect(await pollingQueries('drop_materialized_view', `materialized_view:${db}.${materializedView}`)).toEqual([
        listed(db, materializedView),
      ])
      await executor.command(`DROP TABLE ${object(table)}`)
      expect(await pollingQueries('drop_table', `table:${db}.${table}`)).toEqual([listed(db, table)])
    } finally {
      await executor.command(`DROP VIEW IF EXISTS ${object(view)}`)
      await executor.command(`DROP VIEW IF EXISTS ${object(materializedView)}`)
      await executor.command(`DROP TABLE IF EXISTS ${object(table)}`)
      await executor.command(`DROP TABLE IF EXISTS ${object(target)}`)
      await executor.close()
    }
  }, 120_000)
})

/**
 * Wraps the live executor so each call runs waitForDDLPropagation and returns
 * the distinct polling queries it sent, along with the queries it should send
 * on this target: one replica reads the system table directly, several replicas
 * count the replicas that show the change (#265).
 */
async function recordPollingQueries(executor: ClickHouseExecutor) {
  const queries: string[] = []
  const recording: ClickHouseExecutor = {
    ...executor,
    async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
      queries.push(sql)
      return executor.query<T>(sql, settings)
    },
  }
  const fanout = await resolveReplicaFanout(recording)
  const polled = (source: string, where: string) =>
    fanout
      ? `SELECT count(DISTINCT hostName()) AS replicas FROM ${allReplicas(fanout, source)} WHERE ${where}`
      : `SELECT 1 AS x FROM ${source} WHERE ${where}`
  // The polling queries for names that need no escaping in a string literal.
  const listed = (db: string, name: string) => polled('system.tables', `database = '${db}' AND name = '${name}'`)
  return {
    async pollingQueries(operationType: string, operationKey: string): Promise<string[]> {
      queries.length = 0
      await waitForDDLPropagation(recording, operationType, operationKey)
      return [...new Set(queries)]
    },
    listed,
    listedAsView: (db: string, name: string) =>
      polled('system.tables', `database = '${db}' AND name = '${name}' AND engine LIKE '%View%'`),
    columnListed: (db: string, table: string, column: string) =>
      polled('system.columns', `database = '${db}' AND table = '${table}' AND name = '${column}'`),
  }
}
