import type { MigrationOperationType } from '@chkit/core'
import pRetry from 'p-retry'
import type { ClickHouseExecutor } from './index.js'

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
  ['alter_table_modify_setting', ':setting:'],
  ['alter_table_reset_setting', ':setting:'],
  ['alter_table_modify_ttl', ':ttl'],
  ['alter_table_rename_table', ':rename_table'],
  ['rename_dictionary', ':rename_dictionary'],
])

export async function waitForTable(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
): Promise<void> {
  await pRetry(async () => {
    const rows = await executor.query<{ x: number }>(
      `SELECT 1 AS x FROM system.tables WHERE database = ${stringLiteral(database)} AND name = ${stringLiteral(tableName)}`,
    )
    if (rows.length === 0) {
      throw new Error(`waitForTable: ${database}.${tableName} not yet visible`)
    }
  }, RETRY_OPTIONS)
}

export async function waitForView(
  executor: ClickHouseExecutor,
  database: string,
  viewName: string,
): Promise<void> {
  await pRetry(async () => {
    const rows = await executor.query<{ x: number }>(
      `SELECT 1 AS x FROM system.tables WHERE database = ${stringLiteral(database)} AND name = ${stringLiteral(viewName)} AND engine LIKE '%View%'`,
    )
    if (rows.length === 0) {
      throw new Error(`waitForView: ${database}.${viewName} not yet visible`)
    }
  }, RETRY_OPTIONS)
}

export async function waitForDictionary(
  executor: ClickHouseExecutor,
  database: string,
  dictionaryName: string,
): Promise<void> {
  await pRetry(async () => {
    const rows = await executor.query<{ x: number }>(
      `SELECT 1 AS x FROM system.dictionaries WHERE database = ${stringLiteral(database)} AND name = ${stringLiteral(dictionaryName)}`,
    )
    if (rows.length === 0) {
      throw new Error(`waitForDictionary: ${database}.${dictionaryName} not yet visible`)
    }
  }, RETRY_OPTIONS)
}

export async function waitForColumn(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  columnName: string,
): Promise<void> {
  await pRetry(async () => {
    const rows = await executor.query<{ x: number }>(
      `SELECT 1 AS x FROM system.columns WHERE database = ${stringLiteral(database)} AND table = ${stringLiteral(tableName)} AND name = ${stringLiteral(columnName)}`,
    )
    if (rows.length === 0) {
      throw new Error(
        `waitForColumn: ${database}.${tableName}.${columnName} not yet visible`,
      )
    }
  }, RETRY_OPTIONS)
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
): Promise<void> {
  await pRetry(async () => {
    const rows = await executor.query<{ x: number }>(
      `SELECT 1 AS x FROM system.tables WHERE database = ${stringLiteral(database)} AND name = ${stringLiteral(tableName)}`,
    )
    if (rows.length > 0) {
      throw new Error(
        `waitForTableAbsent: ${database}.${tableName} still present`,
      )
    }
  }, RETRY_OPTIONS)
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
  const column = suffix === ':column:' ? rest.slice(at + suffix.length) : undefined
  return { database, table: rest.slice(0, at), column }
}

/**
 * Waits for DDL propagation based on the operation type and key.
 * Called after each DDL statement in the migration execution loop.
 */
export async function waitForDDLPropagation(
  executor: ClickHouseExecutor,
  operationType: string,
  operationKey: string,
): Promise<void> {
  const parsed = parseOperationKey(operationType, operationKey)
  if (!parsed) return // database-level ops or unrecognized keys — no wait needed

  switch (operationType) {
    case 'create_table':
      return waitForTable(executor, parsed.database, parsed.table)

    case 'create_view':
    case 'create_materialized_view':
      return waitForView(executor, parsed.database, parsed.table)

    case 'create_dictionary':
      return waitForDictionary(executor, parsed.database, parsed.table)

    case 'alter_table_add_column':
    case 'alter_table_modify_column':
      if (parsed.column) {
        return waitForColumn(
          executor,
          parsed.database,
          parsed.table,
          parsed.column,
        )
      }
      return

    case 'drop_table':
    case 'drop_view':
    case 'drop_materialized_view':
    case 'drop_dictionary':
      return waitForTableAbsent(
        executor,
        parsed.database,
        parsed.table,
      )

    default:
      // alter_table_add_index, alter_table_modify_setting,
      // alter_materialized_view_modify_refresh, etc.
      // Wait for the table to exist as a basic sanity check.
      return waitForTable(executor, parsed.database, parsed.table)
  }
}

// Object names may contain quotes and backslashes (DDL backtick-quotes them),
// so the names compared against system tables are escaped string literals.
function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
