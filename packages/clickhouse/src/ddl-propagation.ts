import pRetry from 'p-retry'
import type { ClickHouseExecutor } from './index.js'

const RETRY_OPTIONS = { retries: 20, minTimeout: 500, factor: 1 }

export async function waitForTable(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
): Promise<void> {
  await pRetry(async () => {
    const rows = await executor.query<{ x: number }>(
      `SELECT 1 AS x FROM system.tables WHERE database = '${database}' AND name = '${tableName}'`,
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
      `SELECT 1 AS x FROM system.tables WHERE database = '${database}' AND name = '${viewName}' AND engine LIKE '%View%'`,
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
      `SELECT 1 AS x FROM system.dictionaries WHERE database = '${database}' AND name = '${dictionaryName}'`,
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
      `SELECT 1 AS x FROM system.columns WHERE database = '${database}' AND table = '${tableName}' AND name = '${columnName}'`,
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
      `SELECT 1 AS x FROM system.tables WHERE database = '${database}' AND name = '${tableName}'`,
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
 * or "dictionary:app.users_dict" into its components.
 */
function parseOperationKey(key: string):
  | {
      database: string
      table: string
      column: string | undefined
    }
  | undefined {
  const tableMatch = key.match(/^(?:table|dictionary):([^.]+)\.([^:]+)/)
  if (!tableMatch) return undefined
  // biome-ignore lint/style/noNonNullAssertion: capture groups guaranteed by regex match
  const database = tableMatch[1]!
  // biome-ignore lint/style/noNonNullAssertion: capture groups guaranteed by regex match
  const table = tableMatch[2]!

  const columnMatch = key.match(/:column:([^:]+)/)
  return { database, table, column: columnMatch?.[1] }
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
  const parsed = parseOperationKey(operationKey)
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
      // alter_table_add_index, alter_table_modify_setting, etc.
      // Wait for the table to exist as a basic sanity check.
      return waitForTable(executor, parsed.database, parsed.table)
  }
}
