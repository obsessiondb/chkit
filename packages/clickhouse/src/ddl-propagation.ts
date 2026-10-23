import type { MigrationOperationType } from '@chkit/core'
import pRetry from 'p-retry'
import type { ClickHouseExecutor } from './index.js'
import { allReplicas, resolveReplicaFanout, stringLiteral, type ReplicaFanout } from './replicas.js'

const RETRY_OPTIONS = { retries: 20, minTimeout: 500, factor: 1 }

// What each ALTER or rename appends to the `<kind>:<database>.<name>` key of the
// object it changes. Creates and drops use the bare key.
const KEY_SUFFIXES: ReadonlyMap<string, string> = new Map<MigrationOperationType, string>([
  ['alter_materialized_view_modify_refresh', ':refresh'],
  ['alter_table_add_column', ':column:'],
  ['alter_table_modify_column', ':column:'],
  ['alter_table_drop_column', ':column:'],
  ['alter_table_rename_column', ':column_rename:'],
  ['alter_table_add_index', ':index:'],
  ['alter_table_drop_index', ':index:'],
  ['alter_table_add_projection', ':projection:'],
  ['alter_table_drop_projection', ':projection:'],
  ['alter_table_add_constraint', ':constraint:'],
  ['alter_table_drop_constraint', ':constraint:'],
  ['alter_table_modify_setting', ':setting:'],
  ['alter_table_reset_setting', ':setting:'],
  ['alter_table_modify_ttl', ':ttl'],
  ['alter_table_rename_table', ':rename_table'],
  ['rename_dictionary', ':rename_dictionary'],
])

/**
 * Where a propagation wait looks. Pass the configured `clickhouse.cluster`;
 * without one the `default` cluster is probed (ObsessionDB). On a target with
 * several replicas the wait holds until every replica shows the change: the
 * next statement may land on any of them, and an ALTER that runs on a replica
 * that has not applied the previous one can write back its stale schema.
 */
export interface PropagationOptions {
  cluster?: string
}

export async function waitForTable(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  options?: PropagationOptions,
): Promise<void> {
  await waitForSystemRows(executor, {
    source: 'system.tables',
    where: `database = ${stringLiteral(database)} AND name = ${stringLiteral(tableName)}`,
    want: 'present',
    label: `waitForTable: ${database}.${tableName} not yet visible`,
  }, options)
}

export async function waitForView(
  executor: ClickHouseExecutor,
  database: string,
  viewName: string,
  options?: PropagationOptions,
): Promise<void> {
  await waitForSystemRows(executor, {
    source: 'system.tables',
    where: `database = ${stringLiteral(database)} AND name = ${stringLiteral(viewName)} AND engine LIKE '%View%'`,
    want: 'present',
    label: `waitForView: ${database}.${viewName} not yet visible`,
  }, options)
}

/**
 * Waits until the dictionary's catalog row is on every replica.
 *
 * `system.dictionaries` is the wrong signal. It lists each replica's
 * in-memory loader (`ExternalLoader` load results), not the replicated
 * catalog. `CREATE OR REPLACE DICTIONARY` drops that loader entry while the
 * replica reloads, so a replica can omit the dictionary for the whole retry
 * budget after the DDL is already in `system.tables`. A following statement
 * only needs the catalog object.
 *
 * On several replicas the wait holds until every replica stores the same
 * non-nil `uuid`. A replace does not remove the row, and ClickHouse redacts
 * a SOURCE password to `[HIDDEN]` in `create_table_query`, so a password-only
 * replace compares equal to the previous definition. `CREATE OR REPLACE`
 * still assigns one new UUID in the replicated DDL (an `ON CLUSTER` statement
 * and a Replicated database), and every replica that has applied it reports
 * that UUID. `metadata_modification_time` is each replica's metadata-file
 * mtime at second precision: it can stay unchanged across a replace in the
 * same second, and two replicas that have both applied the DDL can disagree.
 */
export async function waitForDictionary(
  executor: ClickHouseExecutor,
  database: string,
  dictionaryName: string,
  options?: PropagationOptions,
): Promise<void> {
  const where = `database = ${stringLiteral(database)} AND name = ${stringLiteral(dictionaryName)} AND engine = 'Dictionary'`
  const label = `waitForDictionary: ${database}.${dictionaryName} not yet visible`
  const fanout = await resolveReplicaFanout(executor, options?.cluster)
  await pRetry(async () => {
    if (!(await dictionaryCatalogVisible(executor, where, fanout))) throw new Error(label)
  }, RETRY_OPTIONS)
}

export async function waitForColumn(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  columnName: string,
  options?: PropagationOptions,
): Promise<void> {
  await waitForSystemRows(executor, {
    source: 'system.columns',
    where: columnWhere(database, tableName, columnName),
    want: 'present',
    label: `waitForColumn: ${database}.${tableName}.${columnName} not yet visible`,
  }, options)
}

export async function waitForColumnAbsent(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  columnName: string,
  options?: PropagationOptions,
): Promise<void> {
  await waitForSystemRows(executor, {
    source: 'system.columns',
    where: columnWhere(database, tableName, columnName),
    want: 'absent',
    label: `waitForColumnAbsent: ${database}.${tableName}.${columnName} still present`,
  }, options)
}

/**
 * Waits until every replica's `create_table_query` lists the constraint. There
 * is no system table of constraints. A replica that has not applied the ADD
 * yet would let a following `DROP CONSTRAINT IF EXISTS` (a changed constraint)
 * or `ADD CONSTRAINT IF NOT EXISTS` silently do nothing.
 */
async function waitForConstraint(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  constraintName: string,
  options?: PropagationOptions,
): Promise<void> {
  await waitForSystemRows(executor, {
    source: 'system.tables',
    where: constraintWhere(database, tableName, constraintName),
    want: 'present',
    label: `waitForConstraint: ${database}.${tableName}.${constraintName} not yet visible`,
  }, options)
}

async function waitForConstraintAbsent(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  constraintName: string,
  options?: PropagationOptions,
): Promise<void> {
  await waitForSystemRows(executor, {
    source: 'system.tables',
    where: constraintWhere(database, tableName, constraintName),
    want: 'absent',
    label: `waitForConstraintAbsent: ${database}.${tableName}.${constraintName} still present`,
  }, options)
}

/**
 * Polls a query until its rows satisfy `predicate`, then returns them. Use for
 * reads that race DDL/DML propagation on managed ClickHouse (e.g. journal rows
 * written by a just-finished migration that aren't yet visible via FINAL).
 */
export async function waitForRows<T>(
  executor: ClickHouseExecutor,
  sql: string,
  predicate: (rows: T[]) => boolean,
  label = 'waitForRows',
): Promise<T[]> {
  return pRetry(async () => {
    const rows = await executor.query<T>(sql)
    if (!predicate(rows)) {
      throw new Error(`${label}: predicate not yet satisfied`)
    }
    return rows
  }, RETRY_OPTIONS)
}

export async function waitForTableAbsent(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  options?: PropagationOptions,
): Promise<void> {
  await waitForSystemRows(executor, {
    source: 'system.tables',
    where: `database = ${stringLiteral(database)} AND name = ${stringLiteral(tableName)}`,
    want: 'absent',
    label: `waitForTableAbsent: ${database}.${tableName} still present`,
  }, options)
}

/**
 * Parses an operation key like "table:app.users", "table:app.users:column:name",
 * "dictionary:app.users_dict", "view:app.active_users" or
 * "materialized_view:app.events_mv:refresh" into its components. `table` is the
 * object's name in system.tables, which lists views and dictionaries too.
 *
 * Names may contain ':', so the object's name runs to the last occurrence of the
 * suffix its operation type appends; without a known suffix the rest of the key
 * is the name. The database runs to the first '.': the key cannot tell a '.'
 * inside a database name from the separator, so objects in such a database are
 * not found.
 */
function parseOperationKey(
  operationType: string,
  key: string,
):
  | {
      database: string
      table: string
      column: string | undefined
      constraint?: string
    }
  | undefined {
  const keyMatch = key.match(/^(?:table|dictionary|view|materialized_view):([^.]+)\.(.+)$/)
  if (!keyMatch) return undefined
  // biome-ignore lint/style/noNonNullAssertion: capture groups guaranteed by regex match
  const database = keyMatch[1]!
  // biome-ignore lint/style/noNonNullAssertion: capture groups guaranteed by regex match
  const rest = keyMatch[2]!

  const suffix = KEY_SUFFIXES.get(operationType)
  const at = suffix === undefined ? -1 : rest.lastIndexOf(suffix)
  if (suffix === undefined || at < 1) return { database, table: rest, column: undefined }
  const member = rest.slice(at + suffix.length)
  return {
    database,
    table: rest.slice(0, at),
    column: suffix === ':column:' ? member : undefined,
    constraint: suffix === ':constraint:' ? member : undefined,
  }
}

/**
 * Waits for DDL propagation based on the operation type and key.
 * Called after each DDL statement in the migration execution loop.
 */
export async function waitForDDLPropagation(
  executor: ClickHouseExecutor,
  operationType: string,
  operationKey: string,
  options?: PropagationOptions,
): Promise<void> {
  // Backfill assertions execute SELECT guards. Their keys identify the guard,
  // not an object changed by DDL, so there is no schema propagation to await.
  if (operationType === 'assert_backfill') return

  const parsed = parseOperationKey(operationType, operationKey)
  if (!parsed) return // database-level ops or unrecognized keys — no wait needed

  switch (operationType) {
    case 'create_table':
      return waitForTable(executor, parsed.database, parsed.table, options)

    case 'create_view':
    case 'create_materialized_view':
      return waitForView(executor, parsed.database, parsed.table, options)

    case 'create_dictionary':
      return waitForDictionary(executor, parsed.database, parsed.table, options)

    case 'alter_table_add_column':
    case 'alter_table_modify_column':
      if (parsed.column) {
        return waitForColumn(
          executor,
          parsed.database,
          parsed.table,
          parsed.column,
          options,
        )
      }
      return

    case 'alter_table_drop_column':
      if (parsed.column) {
        return waitForColumnAbsent(executor, parsed.database, parsed.table, parsed.column, options)
      }
      return waitForTable(executor, parsed.database, parsed.table, options)

    case 'alter_table_add_constraint':
      if (parsed.constraint) {
        return waitForConstraint(executor, parsed.database, parsed.table, parsed.constraint, options)
      }
      return waitForTable(executor, parsed.database, parsed.table, options)

    case 'alter_table_drop_constraint':
      if (parsed.constraint) {
        return waitForConstraintAbsent(executor, parsed.database, parsed.table, parsed.constraint, options)
      }
      return waitForTable(executor, parsed.database, parsed.table, options)

    case 'drop_table':
    case 'drop_view':
    case 'drop_materialized_view':
    case 'drop_dictionary':
      return waitForTableAbsent(
        executor,
        parsed.database,
        parsed.table,
        options,
      )

    default:
      // alter_table_add_index, alter_table_modify_setting,
      // alter_materialized_view_modify_refresh, etc.
      // Wait for the table to exist as a basic sanity check.
      return waitForTable(executor, parsed.database, parsed.table, options)
  }
}

interface SystemRowsWait {
  source: string
  where: string
  want: 'present' | 'absent'
  label: string
}

async function waitForSystemRows(
  executor: ClickHouseExecutor,
  wait: SystemRowsWait,
  options: PropagationOptions | undefined,
): Promise<void> {
  const fanout = await resolveReplicaFanout(executor, options?.cluster)
  await pRetry(async () => {
    if (!(await systemRowsMatch(executor, wait, fanout))) throw new Error(wait.label)
  }, RETRY_OPTIONS)
}

async function dictionaryCatalogVisible(
  executor: ClickHouseExecutor,
  where: string,
  fanout: ReplicaFanout | undefined,
): Promise<boolean> {
  if (!fanout) {
    const rows = await executor.query<{ x: number }>(`SELECT 1 AS x FROM system.tables WHERE ${where}`)
    return rows.length > 0
  }
  const rows = await executor.query<{ replicas: number | string; agreed: number | string | boolean }>(
    `SELECT count(DISTINCT hostName()) AS replicas, (min(uuid) = max(uuid) AND min(uuid) != toUUID('00000000-0000-0000-0000-000000000000') AND count(uuid) = count()) AS agreed FROM ${allReplicas(fanout, 'system.tables')} WHERE ${where}`,
  )
  const replicas = Number(rows[0]?.replicas ?? 0)
  return replicas >= fanout.replicas && isAgreed(rows[0]?.agreed)
}

function isAgreed(value: number | string | boolean | undefined): boolean {
  return value === true || value === 1 || value === '1'
}

async function systemRowsMatch(
  executor: ClickHouseExecutor,
  wait: SystemRowsWait,
  fanout: ReplicaFanout | undefined,
): Promise<boolean> {
  if (!fanout) {
    const rows = await executor.query<{ x: number }>(`SELECT 1 AS x FROM ${wait.source} WHERE ${wait.where}`)
    return wait.want === 'present' ? rows.length > 0 : rows.length === 0
  }
  const rows = await executor.query<{ replicas: number | string }>(
    `SELECT count(DISTINCT hostName()) AS replicas FROM ${allReplicas(fanout, wait.source)} WHERE ${wait.where}`,
  )
  const replicas = Number(rows[0]?.replicas ?? 0)
  return wait.want === 'present' ? replicas >= fanout.replicas : replicas === 0
}

function columnWhere(database: string, tableName: string, columnName: string): string {
  return `database = ${stringLiteral(database)} AND table = ${stringLiteral(tableName)} AND name = ${stringLiteral(columnName)}`
}

// ClickHouse writes a constraint name bare when it is a plain identifier and
// backquoted otherwise (`backQuoteIfNeed`), so match either spelling.
function constraintWhere(database: string, tableName: string, constraintName: string): string {
  const quoted = `\`${constraintName.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``
  const spellings = [`CONSTRAINT ${constraintName} `, `CONSTRAINT ${quoted} `]
  const listed = spellings.map((spelling) => `position(create_table_query, ${stringLiteral(spelling)}) > 0`).join(' OR ')
  return `database = ${stringLiteral(database)} AND name = ${stringLiteral(tableName)} AND (${listed})`
}
