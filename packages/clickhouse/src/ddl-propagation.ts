import type { MigrationOperationType } from '@chkit/core'
import pRetry from 'p-retry'
import { parseModifyColumnIntent, parseRenameColumn, type ColumnIntent } from './alter-column-statement.js'
import type { ClickHouseExecutor } from './index.js'
import { allReplicas, resolveReplicaFanout, stringLiteral, type ReplicaFanout } from './replicas.js'

const RETRY_OPTIONS = { retries: 20, minTimeout: 500, factor: 1 }

// The `system.columns` fields a column definition wait compares.
const COLUMN_FIELDS = ['type', 'default_kind', 'default_expression', 'comment', 'compression_codec'] as const
type ColumnField = (typeof COLUMN_FIELDS)[number]
type ColumnDefinitionRow = { replica: string } & Record<ColumnField, string>

/** A field value the statement sets; `prefix` matches the start only. */
interface ExpectedColumnValue {
  field: ColumnField
  value: string
  prefix?: boolean
}

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
  /**
   * The statement that ran. A MODIFY COLUMN wait reads what the statement sets
   * from it, and a RENAME COLUMN wait reads the old and new names.
   */
  statement?: string
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
 * Waits until every replica reports the column with one definition, and with
 * what `intent` says the statement set.
 *
 * Agreement: the replica that ran an ALTER has applied it when the statement
 * returns, so once every replica reports the same `type`, `default_kind`,
 * `default_expression`, `comment` and `compression_codec`, all of them have.
 * Each replica formats these values itself, so the comparison is between
 * server-formatted text and never trips over how chkit wrote an expression.
 *
 * Intent: agreement alone passes when every replica kept the old definition,
 * e.g. ObsessionDB ignoring `MODIFY COLUMN ... EPHEMERAL <default>` (#285). So
 * the fields the statement sets are compared too: the default kind and comment
 * verbatim, a removed codec as empty, and the default expression after the
 * server formats it with `formatQuerySingleLine`, the formatter that writes
 * `system.columns.default_expression`. Types and codecs the statement sets are
 * only compared between replicas: ClickHouse rewrites them (`Decimal(10,2)`
 * becomes `Decimal(10, 2)`, `ZSTD` becomes `ZSTD(1)`).
 */
async function waitForColumnDefinition(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  columnName: string,
  intent: ColumnIntent,
  options?: PropagationOptions,
): Promise<void> {
  const fanout = await resolveReplicaFanout(executor, options?.cluster)
  const expected = await expectedColumnValues(executor, intent)
  const source = fanout ? allReplicas(fanout, 'system.columns') : 'system.columns'
  const sql = `SELECT hostName() AS replica, ${COLUMN_FIELDS.join(', ')} FROM ${source} WHERE ${columnWhere(database, tableName, columnName)}`
  await waitUntilApplied(`${database}.${tableName}.${columnName} definition`, async () =>
    columnDefinitionMismatch(await executor.query<ColumnDefinitionRow>(sql), fanout?.replicas ?? 1, expected),
  )
}

/** Waits until no replica lists the old name and every replica lists the new one. */
async function waitForColumnRename(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  rename: { from: string; to: string },
  options?: PropagationOptions,
): Promise<void> {
  const fanout = await resolveReplicaFanout(executor, options?.cluster)
  const replicas = fanout?.replicas ?? 1
  const source = fanout ? allReplicas(fanout, 'system.columns') : 'system.columns'
  const sql = `SELECT hostName() AS replica, name FROM ${source} WHERE database = ${stringLiteral(database)} AND table = ${stringLiteral(tableName)} AND name IN (${stringLiteral(rename.from)}, ${stringLiteral(rename.to)})`
  await waitUntilApplied(`${database}.${tableName} rename of column ${rename.from} to ${rename.to}`, async () => {
    const rows = await executor.query<{ replica: string; name: string }>(sql)
    const stale = rows.filter((row) => row.name === rename.from).map((row) => row.replica)
    if (stale.length > 0) return `replica ${stale.join(', ')} still lists column ${rename.from}`
    const renamed = new Set(rows.filter((row) => row.name === rename.to).map((row) => row.replica))
    if (renamed.size < replicas) return `column ${rename.to} is listed on ${renamed.size} of ${replicas} replicas`
    return undefined
  })
}

async function waitForIndex(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  indexName: string,
  want: 'present' | 'absent',
  options?: PropagationOptions,
): Promise<void> {
  await waitForSystemRows(executor, {
    source: 'system.data_skipping_indices',
    where: `database = ${stringLiteral(database)} AND table = ${stringLiteral(tableName)} AND name = ${stringLiteral(indexName)}`,
    want,
    label: `waitForIndex: ${database}.${tableName}.${indexName} ${want === 'present' ? 'not yet visible' : 'still present'}`,
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
      index?: string
      /** `<from>:<to>` of a column rename. */
      rename?: string
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
    index: suffix === ':index:' ? member : undefined,
    rename: suffix === ':column_rename:' ? member : undefined,
  }
}

/**
 * The old and new names of a column rename. The statement names them; without
 * it the key's `<from>:<to>` is split only when it holds exactly one ':'.
 */
function renamedColumn(member: string, statement: string | undefined): { from: string; to: string } | undefined {
  const parsed = statement === undefined ? undefined : parseRenameColumn(statement)
  if (parsed && `${parsed.from}:${parsed.to}` === member) return parsed
  const parts = member.split(':')
  return parts.length === 2 && parts[0] && parts[1] ? { from: parts[0], to: parts[1] } : undefined
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

    // ADD COLUMN IF NOT EXISTS leaves an existing column as it is, so only
    // agreement between replicas is checked; MODIFY also checks what it sets.
    case 'alter_table_add_column':
    case 'alter_table_modify_column':
      if (parsed.column) {
        const intent =
          operationType === 'alter_table_modify_column' && options?.statement !== undefined
            ? parseModifyColumnIntent(options.statement, parsed.column)
            : {}
        return waitForColumnDefinition(executor, parsed.database, parsed.table, parsed.column, intent, options)
      }
      return

    case 'alter_table_rename_column': {
      const rename = parsed.rename === undefined ? undefined : renamedColumn(parsed.rename, options?.statement)
      if (rename) return waitForColumnRename(executor, parsed.database, parsed.table, rename, options)
      return waitForTable(executor, parsed.database, parsed.table, options)
    }

    case 'alter_table_add_index':
    case 'alter_table_drop_index':
      if (parsed.index) {
        const want = operationType === 'alter_table_add_index' ? 'present' : 'absent'
        return waitForIndex(executor, parsed.database, parsed.table, parsed.index, want, options)
      }
      return waitForTable(executor, parsed.database, parsed.table, options)

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
      // alter_table_add_projection, alter_table_modify_setting,
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

/**
 * Polls `check` until it reports no mismatch. On timeout the error names what
 * was still different on the last check.
 */
async function waitUntilApplied(subject: string, check: () => Promise<string | undefined>): Promise<void> {
  let checks = 0
  try {
    await pRetry(async () => {
      checks += 1
      const mismatch = await check()
      if (mismatch !== undefined) throw new Error(mismatch)
    }, RETRY_OPTIONS)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`waitForDDLPropagation: ${subject} not applied on every replica after ${checks} checks: ${detail}`)
  }
}

/**
 * The `system.columns` values `intent` pins down. The default expression is
 * formatted by the server; when it cannot be formatted (a server without
 * `formatQuerySingleLine`), the expression is left to the agreement check.
 */
async function expectedColumnValues(
  executor: ClickHouseExecutor,
  intent: ColumnIntent,
): Promise<ExpectedColumnValue[]> {
  const expected: ExpectedColumnValue[] = []
  if (intent.defaultKind !== undefined) expected.push({ field: 'default_kind', value: intent.defaultKind })
  if (intent.defaultKind === '') expected.push({ field: 'default_expression', value: '' })
  if (intent.typeDefault) expected.push({ field: 'default_expression', value: 'defaultValueOfTypeName(', prefix: true })
  if (intent.comment !== undefined) expected.push({ field: 'comment', value: intent.comment })
  if (intent.codecRemoved) expected.push({ field: 'compression_codec', value: '' })
  if (intent.defaultExpression !== undefined) {
    const formatted = await formatExpression(executor, intent.defaultExpression)
    if (formatted !== undefined) expected.push({ field: 'default_expression', value: formatted })
  }
  return expected
}

async function formatExpression(executor: ClickHouseExecutor, expression: string): Promise<string | undefined> {
  const select = 'SELECT '
  try {
    const rows = await executor.query<{ formatted: string }>(
      `SELECT formatQuerySingleLine(${stringLiteral(`${select}${expression}`)}) AS formatted`,
    )
    const formatted = rows[0]?.formatted
    return formatted?.startsWith(select) ? formatted.slice(select.length) : undefined
  } catch {
    return undefined
  }
}

/**
 * Why the replicas' rows do not show the intended definition yet, or
 * undefined when every replica reports it.
 */
function columnDefinitionMismatch(
  rows: ColumnDefinitionRow[],
  replicas: number,
  expected: ExpectedColumnValue[],
): string | undefined {
  const listed = new Set(rows.map((row) => row.replica))
  if (listed.size < replicas) {
    const where = listed.size > 0 ? ` (${[...listed].join(', ')})` : ''
    return `the column is listed on ${listed.size} of ${replicas} replicas${where}`
  }
  for (const row of rows) {
    const off = expected.find((want) => !matchesExpected(row[want.field], want))
    if (!off) continue
    const sets = off.prefix ? `${JSON.stringify(off.value)}...` : JSON.stringify(off.value)
    const unanimous = rows.length > 1 && rows.every((other) => other[off.field] === row[off.field])
    return (
      `replica ${row.replica} reports ${off.field} ${JSON.stringify(row[off.field])}, the statement sets ${sets}` +
      (unanimous ? '; every replica reports the same, so this is not replication lag: the server accepted the statement without applying it' : '')
    )
  }
  const [first, ...others] = rows
  if (!first) return undefined
  for (const row of others) {
    const field = COLUMN_FIELDS.find((name) => row[name] !== first[name])
    if (field) {
      return `replica ${row.replica} reports ${field} ${JSON.stringify(row[field])}, replica ${first.replica} reports ${JSON.stringify(first[field])}`
    }
  }
  return undefined
}

function matchesExpected(actual: string, want: ExpectedColumnValue): boolean {
  return want.prefix ? actual.startsWith(want.value) : actual === want.value
}
