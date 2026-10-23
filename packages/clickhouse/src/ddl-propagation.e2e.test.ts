import { describe, expect, test } from 'bun:test'

import { waitForDDLPropagation } from './ddl-propagation.js'
import { createLiveExecutor, createPrefix, getLiveEnv, quoteIdent, waitForTable } from './e2e-testkit.js'
import type { ClickHouseExecutor, ClickHouseSettings } from './index.js'
import { allReplicas, resolveReplicaFanout, stringLiteral } from './replicas.js'

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

  test('a password-only dictionary replace changes the catalog uuid and not the redacted definition', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const db = liveEnv.clickhouseDatabase
    const dict = `${createPrefix('ddlwait_pwd')}dict`
    const object = `${quoteIdent(db)}.${quoteIdent(dict)}`
    const definition = (password: string) =>
      `CREATE OR REPLACE DICTIONARY ${object} (id UInt64, name String) PRIMARY KEY id ` +
      `SOURCE(HTTP(URL 'http://127.0.0.1:1/rows' FORMAT 'JSONEachRow' CREDENTIALS(USER 'default' PASSWORD '${password}'))) ` +
      `LAYOUT(FLAT()) LIFETIME(MIN 0 MAX 300)`
    const catalog = async () => {
      const rows = await executor.query<{ uuid: string; create_table_query: string }>(
        `SELECT toString(uuid) AS uuid, create_table_query FROM system.tables WHERE database = ${stringLiteral(db)} AND name = ${stringLiteral(dict)} AND engine = 'Dictionary'`,
      )
      expect(rows).toHaveLength(1)
      return rows[0]
    }

    try {
      await executor.command(definition('secret-one'))
      await logDictionaryCatalog(executor, db, dict, 'after-create')
      const created = await waitForDDLPropagation(executor, 'create_dictionary', `dictionary:${db}.${dict}`).then(
        () => undefined,
        (error: unknown) => error,
      )
      await logDictionaryCatalog(executor, db, dict, 'after-create-wait')
      if (created) throw created
      const before = await catalog()
      await executor.command(definition('secret-two'))
      await logDictionaryCatalog(executor, db, dict, 'after-replace')
      const replaced = await waitForDDLPropagation(executor, 'create_dictionary', `dictionary:${db}.${dict}`).then(
        () => undefined,
        (error: unknown) => error,
      )
      await logDictionaryCatalog(executor, db, dict, 'after-replace-wait')
      if (replaced) throw replaced
      const after = await catalog()

      expect(before?.uuid).not.toBe('00000000-0000-0000-0000-000000000000')
      expect(after?.uuid).not.toBe(before?.uuid)
      expect(after?.create_table_query).toBe(before?.create_table_query)
      expect(after?.create_table_query).toContain("PASSWORD '[HIDDEN]'")
    } finally {
      await executor.command(`DROP DICTIONARY IF EXISTS ${object}`)
      await executor.close()
    }
  }, 120_000)
})

/**
 * Temporary ObsessionDB evidence for the password-only dictionary wait.
 * Prints database engine, cluster membership, and the raw `clusterAllReplicas`
 * catalog and loader rows. Remove once the live signal is known.
 */
async function logDictionaryCatalog(
  executor: ClickHouseExecutor,
  database: string,
  dictionaryName: string,
  phase: string,
): Promise<void> {
  const where = `database = ${stringLiteral(database)} AND name = ${stringLiteral(dictionaryName)}`
  const fanout = await resolveReplicaFanout(executor)
  const catalogColumns =
    'hostName() AS host, toString(uuid) AS uuid, engine, toString(metadata_modification_time) AS metadata_modification_time, toString(cityHash64(create_table_query)) AS create_table_query_hash'
  const queries: Array<[string, string]> = [
    [
      'database',
      `SELECT name, engine, substring(engine_full, 1, 200) AS engine_full FROM system.databases WHERE name = ${stringLiteral(database)}`,
    ],
    ['clusters', 'SELECT cluster, count() AS replicas FROM system.clusters GROUP BY cluster ORDER BY cluster'],
    [
      'default_replicas',
      "SELECT count(DISTINCT hostName()) AS replicas FROM clusterAllReplicas('default', system.one)",
    ],
    [
      'tables_all_replicas',
      `SELECT ${catalogColumns} FROM clusterAllReplicas('default', system.tables) WHERE ${where} ORDER BY host`,
    ],
    ['tables_local', `SELECT ${catalogColumns} FROM system.tables WHERE ${where}`],
    [
      'agreement',
      `SELECT count(DISTINCT hostName()) AS replicas, count() AS rows, toString(min(uuid)) AS min_uuid, toString(max(uuid)) AS max_uuid, (min(uuid) = max(uuid) AND min(uuid) != toUUID('00000000-0000-0000-0000-000000000000') AND count(uuid) = count()) AS agreed FROM clusterAllReplicas('default', system.tables) WHERE ${where} AND engine = 'Dictionary'`,
    ],
    [
      'engines',
      `SELECT engine, count() AS rows, count(DISTINCT hostName()) AS hosts FROM clusterAllReplicas('default', system.tables) WHERE database = ${stringLiteral(database)} GROUP BY engine ORDER BY engine`,
    ],
    [
      'loader',
      `SELECT hostName() AS host, status, toString(last_successful_update_time) AS last_successful_update_time, toString(loading_start_time) AS loading_start_time FROM clusterAllReplicas('default', system.dictionaries) WHERE ${where} ORDER BY host`,
    ],
  ]
  const snapshot: Record<string, unknown> = {
    phase,
    fanout: fanout ?? null,
  }
  for (const [name, sql] of queries) {
    try {
      snapshot[name] = await executor.query(sql)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      snapshot[name] = { error: message.slice(0, 500) }
    }
  }
  console.log(`[ddl-diag] ${JSON.stringify(snapshot)}`)
}

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
