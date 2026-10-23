/**
 * A `chkit migrate` scenario of consecutive dependent ALTERs on one column
 * (#240). Each statement only succeeds, or only does what it says, when the
 * replica that runs it has applied the previous one: MODIFY COLUMN needs the
 * column, RENAME COLUMN IF EXISTS silently skips a column it cannot see, and
 * the MODIFY after the rename needs the new name. Shared by the default e2e
 * suite (local ClickHouse, ObsessionDB) and the 2-shard cluster suite.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { allReplicas, resolveReplicaFanout, type ClickHouseExecutor } from '@chkit/clickhouse'

import { quoteIdent } from './e2e-testkit.js'

export interface ScenarioTarget {
  database: string
  table: string
  engine: string
  /** Stamps `ON CLUSTER` on every statement and reads every replica of it. */
  cluster?: string
}

export interface ReplicaColumns {
  host: string
  columns: string[]
}

/** `name type default_kind default_expression` of every column, in order. */
export const FINAL_COLUMNS = ['id UInt32  ', 'ts DateTime  ', "z String DEFAULT 'z'"]

export async function writeScenarioMigrations(migrationsDir: string, target: ScenarioTarget): Promise<void> {
  await mkdir(migrationsDir, { recursive: true })
  await writeFile(join(migrationsDir, '20990101000000_create.sql'), createMigration(target), 'utf8')
  await writeFile(join(migrationsDir, '20990101000001_alters.sql'), altersMigration(target), 'utf8')
}

/**
 * Reads the table's columns on every replica of the target (`clickhouse.cluster`,
 * or the `default` cluster ObsessionDB exposes). A single-replica server
 * returns one entry read from `system.columns`.
 */
export async function columnsOnEveryReplica(
  executor: ClickHouseExecutor,
  target: ScenarioTarget,
): Promise<{ replicas: number; hosts: ReplicaColumns[] }> {
  const fanout = await resolveReplicaFanout(executor, target.cluster)
  const source = fanout ? allReplicas(fanout, 'system.columns') : 'system.columns'
  const rows = await executor.query<{ host: string; column: string }>(
    `SELECT hostName() AS host, concat(name, ' ', type, ' ', default_kind, ' ', default_expression) AS column, position FROM ${source} WHERE database = '${target.database}' AND table = '${target.table}' ORDER BY host, position`,
  )
  const hosts = [...new Set(rows.map((row) => row.host))].map((host) => ({
    host,
    columns: rows.filter((row) => row.host === host).map((row) => row.column),
  }))
  return { replicas: fanout?.replicas ?? 1, hosts }
}

function createMigration(target: ScenarioTarget): string {
  return [
    '-- chkit-migration-format: v1',
    `-- operation: create_table key=table:${target.database}.${target.table} risk=safe`,
    `CREATE TABLE IF NOT EXISTS ${fqn(target)}${onCluster(target)} (id UInt32, ts DateTime) ENGINE = ${target.engine} ORDER BY id;`,
    '',
  ].join('\n')
}

function altersMigration(target: ScenarioTarget): string {
  const key = `table:${target.database}.${target.table}`
  const alter = `ALTER TABLE ${fqn(target)}${onCluster(target)}`
  const statements: Array<[type: string, key: string, sql: string]> = [
    ['alter_table_add_column', `${key}:column:x`, `${alter} ADD COLUMN IF NOT EXISTS x UInt32 DEFAULT 1;`],
    ['alter_table_modify_column', `${key}:column:x`, `${alter} MODIFY COLUMN x UInt64 DEFAULT 2;`],
    ['alter_table_modify_column', `${key}:column:x`, `${alter} MODIFY COLUMN x UInt64 MATERIALIZED id + 3;`],
    ['alter_table_modify_column', `${key}:column:x`, `${alter} MODIFY COLUMN x UInt64 MATERIALIZED id + 4;`],
    ['alter_table_rename_column', `${key}:column_rename:x:y`, `${alter} RENAME COLUMN IF EXISTS x TO y;`],
    ['alter_table_modify_column', `${key}:column:y`, `${alter} MODIFY COLUMN y UInt64 DEFAULT id + 5;`],
    ['alter_table_add_column', `${key}:column:z`, `${alter} ADD COLUMN IF NOT EXISTS z String DEFAULT 'z';`],
    ['alter_table_drop_column', `${key}:column:y`, `${alter} DROP COLUMN IF EXISTS y;`],
  ]
  return [
    '-- chkit-migration-format: v1',
    `-- operation-count: ${statements.length}`,
    '',
    ...statements.map(([type, opKey, sql]) => `-- operation: ${type} key=${opKey} risk=safe\n${sql}\n`),
  ].join('\n')
}

function fqn(target: ScenarioTarget): string {
  return `${quoteIdent(target.database)}.${quoteIdent(target.table)}`
}

function onCluster(target: ScenarioTarget): string {
  return target.cluster ? ` ON CLUSTER '${target.cluster}'` : ''
}
