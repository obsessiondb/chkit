import { setTimeout as sleep } from 'node:timers/promises'

import {
  allReplicas,
  isUnknownDatabaseError,
  resolveReplicaFanout,
  waitForColumn,
  waitForTable,
  type ClickHouseExecutor,
  type ReplicaFanout,
} from '@chkit/clickhouse'
import { onClusterClause, quoteIdentifier } from '@chkit/core'
import pRetry from 'p-retry'

import { createTableElementNames } from './create-table-columns.js'
import type { MigrationJournal, MigrationJournalEntry } from './migration-store.js'
import { CLI_VERSION } from './version.js'
import { debug } from './debug.js'

export type OperationStatus = 'started' | 'completed' | 'failed'

export interface OperationState {
  operationIndex: number
  operationKey: string
  operationType: string
  queryId: string
  status: OperationStatus
  startedAt: string
  finishedAt: string | null
  lastError: string
  /**
   * The `statementFingerprint` of the statement this record is about, so a
   * resume can tell it is still that statement (#599). Empty when it was not
   * recorded: an older chkit wrote the row, or the journal has no column for it.
   */
  fingerprint: string
}

export interface MigrationRowState {
  name: string
  appliedAt: string
  checksum: string
  chkitVersion: string
  migrationCompleted: boolean
  operations: OperationState[]
}

export interface JournalStore {
  readJournal(): Promise<MigrationJournal>
  readMigrationState(migrationName: string): Promise<MigrationRowState | null>
  writeMigrationState(state: MigrationRowState): Promise<void>
  appendEntry(entry: MigrationJournalEntry): Promise<void>
  readonly databaseMissing: boolean
}

const DEFAULT_JOURNAL_TABLE = '_chkit_migrations'

export function resolveJournalTableName(): string {
  const candidate = process.env.CHKIT_JOURNAL_TABLE?.trim()
  if (!candidate) return DEFAULT_JOURNAL_TABLE
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) {
    throw new Error(
      `Invalid CHKIT_JOURNAL_TABLE "${candidate}". Expected unquoted identifier matching [A-Za-z_][A-Za-z0-9_]*`
    )
  }
  return candidate
}

interface MigrationRow extends Record<string, unknown> {
  name: string
  applied_at: string
  checksum: string
  chkit_version: string
  migration_completed?: boolean | number | string
  // Read via `toJSONString(operations)`, so every executor returns this as a
  // JSON-encoded string. The native client otherwise returns named-tuple columns
  // as objects and the ObsessionDB workbench API returns every cell as a string —
  // serializing to JSON in SQL makes the read identical across both. `parseOperations`
  // still tolerates an already-decoded array for mocks/back-compat.
  operations?: string | OperationTupleRow[]
  // `toJSONString(operation_fingerprints)`, parallel to `operations`; only
  // selected when the journal has the column.
  operation_fingerprints?: string | string[]
}

interface OperationTupleRow {
  operation_index: number | string
  operation_key: string
  operation_type: string
  query_id: string
  status: string
  started_at: string
  finished_at: string | null
  last_error: string
}

const OPERATIONS_TUPLE_TYPE =
  'Array(Tuple(operation_index Int32, operation_key String, operation_type String, query_id String, status LowCardinality(String), started_at DateTime64(3, \'UTC\'), finished_at Nullable(DateTime64(3, \'UTC\')), last_error String))'

/**
 * One fingerprint per entry of `operations`, in the same order (#599). A
 * separate column, so the `operations` type older releases write stays the
 * same. Older releases name their INSERT columns, so a row they write gets
 * `[]` here: a fingerprint is only ever read from a row whose writer recorded
 * it for that very record.
 */
const FINGERPRINTS_COLUMN = 'operation_fingerprints'
const FINGERPRINTS_COLUMN_DEFINITION = `${FINGERPRINTS_COLUMN} Array(String) DEFAULT []`

interface ClickHouseErrorKind {
  code: string
  name: string
  /** The message, for the ObsessionDB console API, which sends neither code nor name. */
  message: RegExp
}

const UNKNOWN_TABLE: ClickHouseErrorKind = {
  code: '60',
  name: 'UNKNOWN_TABLE',
  message: /Unknown table expression identifier|Table \S+ does not exist/,
}
const UNKNOWN_IDENTIFIER: ClickHouseErrorKind = {
  code: '47',
  name: 'UNKNOWN_IDENTIFIER',
  message: /Unknown expression identifier|Missing columns/,
}
const READONLY: ClickHouseErrorKind = { code: '164', name: 'READONLY', message: /in readonly mode/ }
const ACCESS_DENIED: ClickHouseErrorKind = { code: '497', name: 'ACCESS_DENIED', message: /Not enough privileges/ }

/** Whether `error` is the ClickHouse error `kind`. The native client sets `code`. */
function isClickHouseError(error: unknown, kind: ClickHouseErrorKind): boolean {
  if (!(error instanceof Error)) return false
  if ('code' in error && String(error.code) === kind.code) return true
  return error.message.includes(kind.name) || kind.message.test(error.message)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The one line a run prints when it cannot add the fingerprint column, so a
 * user without ALTER on the journal knows the SQL check of --retry is off.
 */
function fingerprintColumnWarning(journalTable: string, error: unknown): string {
  const reason = (errorText(error).split('\n')[0] ?? '').trim().replace(/\.$/, '')
  return (
    `⚠ Could not add the ${FINGERPRINTS_COLUMN} column to ${journalTable} (${reason}), so this run records no statement fingerprints: ` +
    'a later --retry or resume checks the statements it completes by position and "-- operation:" marker only, not by their SQL. ' +
    `The next migration applied by a user that can ALTER ${journalTable} adds the column.`
  )
}

/** Retries of the journal CREATE while its database reaches the replica (#493). */
const CREATE_RETRIES = 20

function isRetryableInsertRace(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message
  return message.includes('INSERT race condition') || message.includes('Please retry the INSERT')
}

function escapeSqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function operationToTupleLiteral(op: OperationState): string {
  const parts = [
    String(op.operationIndex),
    `'${escapeSqlString(op.operationKey)}'`,
    `'${escapeSqlString(op.operationType)}'`,
    `'${escapeSqlString(op.queryId)}'`,
    `'${escapeSqlString(op.status)}'`,
    `'${escapeSqlString(op.startedAt)}'`,
    op.finishedAt === null ? 'NULL' : `'${escapeSqlString(op.finishedAt)}'`,
    `'${escapeSqlString(op.lastError)}'`,
  ]
  return `(${parts.join(',')})`
}

function operationsArrayLiteral(operations: OperationState[]): string {
  if (operations.length === 0) return '[]'
  return `[${operations.map(operationToTupleLiteral).join(',')}]`
}

function fingerprintsArrayLiteral(operations: OperationState[]): string {
  return `[${operations.map((op) => `'${escapeSqlString(op.fingerprint)}'`).join(',')}]`
}

function operationFromTuple(row: OperationTupleRow, fingerprint: string): OperationState {
  return {
    operationIndex: Number(row.operation_index),
    operationKey: row.operation_key,
    operationType: row.operation_type,
    queryId: row.query_id,
    status: row.status as OperationStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
    fingerprint,
  }
}

// The native ClickHouse client returns a JS boolean; the ObsessionDB workbench
// API returns every cell as a string ("true"/"false"). Compare explicitly —
// `Boolean("false")` is `true`, which would silently corrupt the read.
function parseBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

// `operations` is selected via `toJSONString(...)`, so it arrives as a JSON
// string from every executor. Tolerate an already-decoded array too (mocks /
// any future typed executor) and degrade to [] on anything unparseable.
function parseOperations(value: unknown, fingerprintsValue: unknown): OperationState[] {
  const decoded = parseJsonArray(value)
  const fingerprints = parseFingerprints(fingerprintsValue, decoded.length)
  return decoded.map((row, index) => operationFromTuple(row as OperationTupleRow, fingerprints[index] ?? ''))
}

// The fingerprints count only when there is one per operation: a row an older
// release wrote has `[]`, and its operations then have none.
function parseFingerprints(value: unknown, operationCount: number): string[] {
  const decoded = parseJsonArray(value)
  if (decoded.length !== operationCount || !decoded.every((item) => typeof item === 'string')) return []
  return decoded
}

function parseJsonArray(value: unknown): unknown[] {
  if (value == null || value === '') return []
  let decoded: unknown = value
  if (typeof value === 'string') {
    try {
      decoded = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(decoded) ? decoded : []
}

/**
 * The `ReplacingMergeTree(applied_at)` version as epoch milliseconds. ClickHouse
 * returns `DateTime64(3, 'UTC')` without a zone and chkit writes ISO strings with
 * or without `Z`; all of them are UTC.
 */
function rowVersion(appliedAt: string): number {
  const iso = appliedAt.trim().replace(' ', 'T')
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
}

export function createJournalStore(db: ClickHouseExecutor, cluster?: string): JournalStore {
  const journalTable = resolveJournalTableName()
  debug('journal', `journal table: ${journalTable}${process.env.CHKIT_JOURNAL_TABLE ? ' (from CHKIT_JOURNAL_TABLE)' : ''}${cluster ? ` (ON CLUSTER ${cluster})` : ''}`)
  // In cluster mode the journal must be consistent across every node, so it uses
  // a replicated engine with a no-`{shard}` Keeper path (one cluster-wide group)
  // created `ON CLUSTER`. `{uuid}` is minted once per CREATE and propagated to
  // all nodes by ON CLUSTER, so a dropped journal's stale Keeper entries can
  // never collide with a recreate (REPLICA_ALREADY_EXISTS). The replica id is
  // `{shard}_{replica}` rather than bare `{replica}`: because the path omits
  // `{shard}`, all nodes across all shards share it, so the replica name must be
  // unique cluster-wide — per-shard `{replica}` naming (the common multi-shard
  // layout) would otherwise collide. The read path already uses SYNC REPLICA +
  // FINAL + sequential consistency. Single-node/Cloud keeps the plain engine.
  const onCluster = onClusterClause(cluster)
  const journalEngine = cluster
    ? "ReplicatedReplacingMergeTree('/clickhouse/tables/{uuid}/chkit_journal', '{shard}_{replica}', applied_at)"
    : 'ReplacingMergeTree(applied_at)'
  // Named in its database: the executor retries a statement that fails with
  // UNKNOWN_DATABASE without the database, which would otherwise create the
  // journal in the server's default database (#493).
  const createTableSql = (database: string) => `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(database)}.${journalTable}${onCluster} (
    name String,
    applied_at DateTime64(3, 'UTC'),
    checksum String,
    chkit_version String,
    migration_completed Bool DEFAULT true,
    operations ${OPERATIONS_TUPLE_TYPE} DEFAULT [],
    ${FINGERPRINTS_COLUMN_DEFINITION}
) ENGINE = ${journalEngine}
ORDER BY (name)
SETTINGS index_granularity = 1`

  let bootstrapped = false
  let _databaseMissing = false
  // The database exists but the journal does not: reads see no rows, and the
  // first write creates it.
  let tableMissing = false
  let replicaSyncSupported: boolean | undefined
  // Whether the journal has the operation_fingerprints column (#599). It is
  // false only once chkit saw that the column is missing, in a journal an
  // older release created: this run then reads and writes it as that release
  // does. Any other failure to tell stops the run instead, so fingerprints
  // that were recorded are never read as missing.
  let fingerprintColumn = false
  let fingerprintColumnAdded = false
  // The user may not read system.columns; the column is then read from the
  // journal's definition in system.tables.
  let columnsUnreadable = false
  // Read-your-writes: the last row version this store wrote per migration.
  const lastWritten = new Map<string, MigrationRowState>()

  /**
   * Makes sure the journal can be read or, with `create`, written. Only a
   * write creates the journal or adds the columns an old one lacks, so
   * status, check and migrate (plan) run as a read-only user (#402).
   */
  async function ensureTable(create: boolean): Promise<void> {
    if (bootstrapped || (tableMissing && !create)) return
    debug('journal', `probing journal table "${journalTable}"`)
    try {
      await db.query(`SELECT name, migration_completed, operations FROM ${journalTable} LIMIT 0`)
      debug('journal', 'journal table exists')
      await waitForEveryReplica()
      fingerprintColumn = await detectFingerprintColumn()
      bootstrapped = true
      tableMissing = false
      return
    } catch (error) {
      if (isUnknownDatabaseError(error)) {
        debug('journal', 'database does not exist')
        _databaseMissing = true
        bootstrapped = true
        return
      }
      if (isClickHouseError(error, UNKNOWN_IDENTIFIER)) {
        debug('journal', 'journal table predates per-operation tracking — upgrading')
        await ensureSchemaUpgraded()
        await waitForEveryReplica()
        fingerprintColumn = await detectFingerprintColumn()
        bootstrapped = true
        return
      }
      if (!create) {
        if (!isClickHouseError(error, UNKNOWN_TABLE)) throw error
        if (await existsOnAnotherReplica()) {
          await waitForEveryReplica()
          fingerprintColumn = await detectFingerprintColumn()
          bootstrapped = true
          return
        }
        debug('journal', 'journal table does not exist — reading it as empty')
        tableMissing = true
        return
      }
    }
    debug('journal', 'creating journal table')
    await createJournalTable()
    await pRetry(async (attempt) => {
      await db.query(`SELECT name FROM ${journalTable} LIMIT 0`)
      debug('journal', `DDL propagation confirmed (attempt ${attempt})`)
    }, { retries: 9, minTimeout: 250, factor: 1 }).catch(() => undefined)
    await waitForEveryReplica()
    // Another process, maybe an older release, may have created it first.
    fingerprintColumn = await detectFingerprintColumn()
    bootstrapped = true
    tableMissing = false
  }

  // The probe found the database, so UNKNOWN_DATABASE here means this request
  // reached a replica that has not applied CREATE DATABASE yet (#493): retry
  // until it has. A database that never arrives stops the run, so the state
  // being written is never dropped.
  async function createJournalTable(): Promise<void> {
    try {
      await pRetry(async () => {
        await db.command(createTableSql(await currentDatabase()))
      }, {
        retries: CREATE_RETRIES,
        minTimeout: 500,
        factor: 1,
        shouldRetry: ({ error, attemptNumber }) => {
          if (!isUnknownDatabaseError(error)) return false
          debug('journal', `database not yet on this replica — retrying the journal CREATE (attempt ${attemptNumber})`)
          return true
        },
      })
    } catch (error) {
      if (!isUnknownDatabaseError(error)) throw error
      throw new Error(
        `Cannot create the journal table ${journalTable}: its database is still missing on the replica that received the CREATE after ${CREATE_RETRIES + 1} attempts. Re-run chkit once the database has reached every replica. ${errorText(error)}`,
        { cause: error },
      )
    }
  }

  // On a multi-replica target, the replica that answered the probe may not
  // have applied another process's CREATE yet.
  async function existsOnAnotherReplica(): Promise<boolean> {
    const fanout = await resolveReplicaFanout(db, cluster)
    if (!fanout) return false
    const [row] = await db.query<{ replicas: number | string }>(
      `SELECT count() AS replicas FROM ${allReplicas(fanout, 'system.tables')} WHERE database = currentDatabase() AND name = '${journalTable}'`,
    )
    return Number(row?.replicas ?? 0) > 0
  }

  // A multi-replica target reads the journal from every replica (#265), which
  // fails while one of them does not have the table yet, e.g. right after the
  // CREATE above or another process's. A single replica needs no wait.
  async function waitForEveryReplica(): Promise<void> {
    if (!(await resolveReplicaFanout(db, cluster))) return
    await waitForTable(db, await currentDatabase(), journalTable, { cluster })
  }

  async function currentDatabase(): Promise<string> {
    const [row] = await db.query<{ database: string }>('SELECT currentDatabase() AS database')
    return row?.database ?? 'default'
  }

  /**
   * Whether the journal has the fingerprint column. Only a server that says
   * the column is missing makes it false; any other error stops the run. On
   * several replicas, the column counts when any replica has it (one that
   * lags may not yet), and then every replica must get it, because reads and
   * writes name it.
   */
  async function detectFingerprintColumn(): Promise<boolean> {
    const fanout = await resolveReplicaFanout(db, cluster)
    if (!fanout) {
      try {
        await db.query(`SELECT ${FINGERPRINTS_COLUMN} FROM ${journalTable} LIMIT 0`)
        return true
      } catch (error) {
        if (!isClickHouseError(error, UNKNOWN_IDENTIFIER)) throw error
        debug('journal', `journal table has no ${FINGERPRINTS_COLUMN} column`)
        return false
      }
    }
    let rows: Array<{ replicas: number | string }>
    try {
      rows = await db.query<{ replicas: number | string }>(
        `SELECT count() AS replicas FROM ${allReplicas(fanout, 'system.columns')} WHERE database = currentDatabase() AND table = '${journalTable}' AND name = '${FINGERPRINTS_COLUMN}'`,
      )
    } catch (error) {
      if (!isClickHouseError(error, ACCESS_DENIED)) throw error
      debug('journal', `cannot read system.columns — reading the journal definition from system.tables: ${errorText(error)}`)
      columnsUnreadable = true
      return await detectFingerprintColumnFromTables(fanout)
    }
    const [row] = rows
    if (Number(row?.replicas ?? 0) === 0) {
      debug('journal', `no replica has the ${FINGERPRINTS_COLUMN} column`)
      return false
    }
    await waitForColumn(db, await currentDatabase(), journalTable, FINGERPRINTS_COLUMN, { cluster })
    return true
  }

  /**
   * How many replicas list the journal, and how many of them define the
   * fingerprint column, read from each replica's CREATE statement in
   * system.tables. For a user that cannot read system.columns (#402): it
   * answers per replica, as system.columns does. A probe through the journal
   * itself cannot, because a remote query takes its columns from one replica,
   * and `hasColumnInTable` is folded into a constant on the replica that
   * runs the query. The CREATE statement is read whatever identifier quoting
   * the user's settings choose; one chkit cannot read stops the run.
   */
  async function replicasWithFingerprintColumn(fanout: ReplicaFanout): Promise<{ replicas: number; withColumn: number }> {
    const rows = await db.query<{ replica: string; create_table_query: string }>(
      `SELECT hostName() AS replica, create_table_query FROM ${allReplicas(fanout, 'system.tables')} WHERE database = currentDatabase() AND name = '${journalTable}'`,
    )
    const replicas = new Set<string>()
    const withColumn = new Set<string>()
    for (const row of rows) {
      replicas.add(row.replica)
      const names = createTableElementNames(row.create_table_query)
      if (!names) {
        throw new Error(
          `Cannot tell whether the journal table ${journalTable} has the ${FINGERPRINTS_COLUMN} column: cannot read its definition on replica ${row.replica}.`,
        )
      }
      if (names.includes(FINGERPRINTS_COLUMN)) withColumn.add(row.replica)
    }
    return { replicas: replicas.size, withColumn: withColumn.size }
  }

  /**
   * detectFingerprintColumn without system.columns. The column is missing only
   * when every replica lists the journal without it; when a replica does not
   * list the journal, chkit cannot tell, and stops rather than read recorded
   * fingerprints as missing. A column some replicas have is waited for.
   */
  async function detectFingerprintColumnFromTables(fanout: ReplicaFanout): Promise<boolean> {
    const { replicas, withColumn } = await replicasWithFingerprintColumn(fanout)
    if (withColumn > 0) {
      await waitForFingerprintColumnInTables(fanout)
      return true
    }
    if (replicas < fanout.replicas) {
      throw new Error(
        `Cannot tell whether the journal table ${journalTable} has the ${FINGERPRINTS_COLUMN} column: ${replicas} of ${fanout.replicas} replicas list it. Re-run chkit once every replica has the table.`,
      )
    }
    debug('journal', `no replica has the ${FINGERPRINTS_COLUMN} column`)
    return false
  }

  async function waitForFingerprintColumnInTables(fanout: ReplicaFanout): Promise<void> {
    await pRetry(async () => {
      const { withColumn } = await replicasWithFingerprintColumn(fanout)
      if (withColumn < fanout.replicas) {
        throw new Error(`waitForColumn: ${journalTable}.${FINGERPRINTS_COLUMN} not yet visible`)
      }
    }, { retries: 20, minTimeout: 500, factor: 1 })
  }

  /** Waits until every replica has the fingerprint column, after this run added it. */
  async function waitForFingerprintColumn(fanout: ReplicaFanout): Promise<void> {
    if (columnsUnreadable) return await waitForFingerprintColumnInTables(fanout)
    await waitForColumn(db, await currentDatabase(), journalTable, FINGERPRINTS_COLUMN, { cluster })
  }

  /**
   * Adds the fingerprint column to a journal that an older release created,
   * on the first write of a run. A user that cannot ALTER the journal still
   * migrates, without fingerprints, as before (#599).
   */
  async function ensureFingerprintColumn(): Promise<void> {
    if (fingerprintColumn || fingerprintColumnAdded) return
    fingerprintColumnAdded = true
    try {
      await db.command(`ALTER TABLE ${journalTable}${onCluster} ADD COLUMN IF NOT EXISTS ${FINGERPRINTS_COLUMN_DEFINITION}`)
    } catch (error) {
      debug('journal', `could not add ${FINGERPRINTS_COLUMN} — recording no fingerprints: ${errorText(error)}`)
      console.error(fingerprintColumnWarning(journalTable, error))
      return
    }
    const fanout = await resolveReplicaFanout(db, cluster)
    if (fanout) await waitForFingerprintColumn(fanout)
    fingerprintColumn = true
  }

  async function ensureSchemaUpgraded(): Promise<void> {
    // Pre-existing journal tables predate per-operation tracking. Add the
    // columns idempotently so older deployments pick them up on first run
    // of the new chkit. ALTER ADD COLUMN IF NOT EXISTS is a metadata op,
    // no data rewrite.
    try {
      await db.command(
        `ALTER TABLE ${journalTable}${onCluster} ADD COLUMN IF NOT EXISTS migration_completed Bool DEFAULT true`,
      )
      await db.command(
        `ALTER TABLE ${journalTable}${onCluster} ADD COLUMN IF NOT EXISTS operations ${OPERATIONS_TUPLE_TYPE} DEFAULT []`,
      )
      await db.command(
        `ALTER TABLE ${journalTable}${onCluster} ADD COLUMN IF NOT EXISTS ${FINGERPRINTS_COLUMN_DEFINITION}`,
      )
    } catch (error) {
      // A read-only user cannot run the ALTER (#402).
      throw new Error(
        `The journal table ${journalTable} predates per-operation tracking and needs its new columns added. Run chkit once as a user that can ALTER it (as migrate --apply needs). ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  /**
   * The rows to read the journal from. A single replica reads the table with
   * FINAL. With several replicas (#265), the replica a read lands on may not
   * have the latest version yet, while the replica that ran an INSERT always
   * has it: read every replica and keep the newest version per migration. Each
   * write stamps applied_at in milliseconds as the row version, which is what
   * ReplacingMergeTree(applied_at) keeps too.
   */
  async function journalRows(where: string, limit = ''): Promise<MigrationRow[]> {
    const fingerprints = fingerprintColumn
    const fanout = await resolveReplicaFanout(db, cluster)
    const fingerprintSelect = `toJSONString(${FINGERPRINTS_COLUMN})`
    const columns = `name, applied_at, checksum, chkit_version, migration_completed, toJSONString(operations) AS operations${fingerprints ? `, ${fingerprintSelect} AS ${FINGERPRINTS_COLUMN}` : ''}`
    if (!fanout) {
      const sql = `SELECT ${columns} FROM ${journalTable} FINAL WHERE ${where} ORDER BY name${limit}`
      try {
        return await db.query<MigrationRow>(`${sql} SETTINGS select_sequential_consistency = 1`)
      } catch (error) {
        // A readonly = 1 user cannot change any setting (#402). It only
        // reads, so there is no write of its own to wait for.
        if (!isClickHouseError(error, READONLY)) throw error
        debug('journal', 'read-only user — reading the journal without select_sequential_consistency')
        return await db.query<MigrationRow>(sql)
      }
    }
    debug('journal', `reading the journal across ${fanout.replicas} replicas of cluster ${fanout.cluster}`)
    // The fingerprints come from the same row version as the operations.
    const latest = fingerprints ? `, latest.6 AS ${FINGERPRINTS_COLUMN}` : ''
    const versioned = fingerprints ? `, ${fingerprintSelect}` : ''
    return await db.query<MigrationRow>(
      `SELECT name, latest.1 AS applied_at, latest.2 AS checksum, latest.3 AS chkit_version, latest.4 AS migration_completed, latest.5 AS operations${latest} FROM (SELECT name, argMax(tuple(applied_at, checksum, chkit_version, migration_completed, toJSONString(operations)${versioned}), applied_at) AS latest FROM clusterAllReplicas('${escapeSqlString(fanout.cluster)}', currentDatabase(), '${journalTable}') GROUP BY name) WHERE ${where} ORDER BY name${limit}`,
    )
  }

  async function insertState(state: MigrationRowState, fingerprints: boolean): Promise<void> {
    const fingerprintColumnName = fingerprints ? `, ${FINGERPRINTS_COLUMN}` : ''
    const fingerprintValue = fingerprints ? `, ${fingerprintsArrayLiteral(state.operations)}` : ''
    const insertSql = `INSERT INTO ${journalTable} (name, applied_at, checksum, chkit_version, migration_completed, operations${fingerprintColumnName}) VALUES ('${escapeSqlString(state.name)}', '${escapeSqlString(state.appliedAt)}', '${escapeSqlString(state.checksum)}', '${escapeSqlString(state.chkitVersion)}', ${state.migrationCompleted ? 'true' : 'false'}, ${operationsArrayLiteral(state.operations)}${fingerprintValue})`
    await pRetry(() => db.command(insertSql), {
      retries: 4,
      minTimeout: 0,
      shouldRetry: async ({ error, attemptNumber }) => {
        if (!isRetryableInsertRace(error)) return false
        debug('journal', `insert race detected — retrying (attempt ${attemptNumber}/5)`)
        await sleep(attemptNumber * 150)
        return true
      },
    })
  }

  async function trySyncReplica(): Promise<void> {
    if (replicaSyncSupported === undefined) {
      try {
        const rows = await db.query<{ engine: string }>(
          `SELECT engine FROM system.tables WHERE database = currentDatabase() AND name = '${journalTable}'`,
        )
        // Only skip synchronization when the actual engine is known. If system
        // metadata is unavailable, retain the existing best-effort sync behavior.
        replicaSyncSupported = rows[0] ? rows[0].engine.startsWith('Replicated') : true
      } catch {
        replicaSyncSupported = true
      }
    }
    if (!replicaSyncSupported) return
    try {
      await db.command(`SYSTEM SYNC REPLICA ${journalTable}`)
    } catch {
      // Non-replicated or single-node setups don't support SYSTEM SYNC REPLICA.
    }
  }

  return {
    get databaseMissing() {
      return _databaseMissing
    },

    async readJournal(): Promise<MigrationJournal> {
      debug('journal', 'reading journal')
      await ensureTable(false)
      if (_databaseMissing || tableMissing) {
        debug('journal', 'database or journal table missing — returning empty journal')
        return { version: 1, applied: [] }
      }
      await trySyncReplica()
      const rows = await journalRows('migration_completed = true')
      debug('journal', `journal has ${rows.length} applied entries`)
      return {
        version: 1,
        applied: rows.map((row) => ({
          name: row.name,
          appliedAt: row.applied_at,
          checksum: row.checksum,
        })),
      }
    },

    async readMigrationState(migrationName: string): Promise<MigrationRowState | null> {
      await ensureTable(false)
      if (_databaseMissing || tableMissing) return null
      await trySyncReplica()
      const rows = await journalRows(`name = '${escapeSqlString(migrationName)}'`, ' LIMIT 1')
      const written = lastWritten.get(migrationName)
      const row = rows[0]
      if (!row) return written ?? null
      const state: MigrationRowState = {
        name: row.name,
        appliedAt: row.applied_at,
        checksum: row.checksum,
        chkitVersion: row.chkit_version,
        migrationCompleted: parseBool(row.migration_completed),
        operations: parseOperations(row.operations, row.operation_fingerprints),
      }
      // Each request can land on a different replica, and SYSTEM SYNC REPLICA
      // on one request does not make the next one read our write. Never hand a
      // read-modify-write caller a version older than the one we just wrote, or
      // its write would drop the progress recorded in between.
      if (written && rowVersion(state.appliedAt) < rowVersion(written.appliedAt)) {
        debug('journal', `stale journal read for ${migrationName} — using the last written version`)
        return written
      }
      return state
    },

    async writeMigrationState(input: MigrationRowState): Promise<void> {
      // The release that wrote the state last. migrate checks a state another
      // release wrote before it resumes it, so the statement positions in a
      // state this release wrote are always this release's split (#562).
      const state = { ...input, chkitVersion: CLI_VERSION }
      if (_databaseMissing) {
        debug('journal', 'resetting databaseMissing flag — migration may have created the database')
        _databaseMissing = false
        bootstrapped = false
      }
      await ensureTable(true)
      if (_databaseMissing) {
        // Nothing to journal until the migration creates the database; the
        // INSERT would otherwise fall back to the server's default database.
        debug('journal', 'database still missing — skipping journal write')
        return
      }
      await ensureFingerprintColumn()
      await insertState(state, fingerprintColumn)
      lastWritten.set(state.name, state)
      await trySyncReplica()
    },

    async appendEntry(entry: MigrationJournalEntry): Promise<void> {
      debug('journal', `appending entry: ${entry.name} (checksum: ${entry.checksum})`)
      // Preserve any per-operation history that async statements wrote
      // earlier in this migration's apply — we just flip migrationCompleted.
      const existing = await this.readMigrationState(entry.name)
      await this.writeMigrationState({
        name: entry.name,
        appliedAt: entry.appliedAt,
        checksum: entry.checksum,
        chkitVersion: CLI_VERSION,
        migrationCompleted: true,
        operations: existing?.operations ?? [],
      })
    },
  }
}
