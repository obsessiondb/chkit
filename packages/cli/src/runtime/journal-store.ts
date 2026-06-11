import { isUnknownDatabaseError, type ClickHouseExecutor } from '@chkit/clickhouse'

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
  migration_completed?: boolean | number
  // ClickHouse JSONEachRow returns named-tuple columns as objects keyed by the
  // tuple field names, not as positional arrays.
  operations?: OperationTupleRow[]
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

function operationFromTuple(row: OperationTupleRow): OperationState {
  return {
    operationIndex: Number(row.operation_index),
    operationKey: row.operation_key,
    operationType: row.operation_type,
    queryId: row.query_id,
    status: row.status as OperationStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
  }
}

export function createJournalStore(db: ClickHouseExecutor): JournalStore {
  const journalTable = resolveJournalTableName()
  debug('journal', `journal table: ${journalTable}${process.env.CHKIT_JOURNAL_TABLE ? ' (from CHKIT_JOURNAL_TABLE)' : ''}`)
  const createTableSql = `CREATE TABLE IF NOT EXISTS ${journalTable} (
    name String,
    applied_at DateTime64(3, 'UTC'),
    checksum String,
    chkit_version String,
    migration_completed Bool DEFAULT true,
    operations ${OPERATIONS_TUPLE_TYPE} DEFAULT []
) ENGINE = ReplacingMergeTree(applied_at)
ORDER BY (name)
SETTINGS index_granularity = 1`

  let bootstrapped = false
  let _databaseMissing = false

  async function ensureTable(): Promise<void> {
    if (bootstrapped) return
    debug('journal', `probing journal table "${journalTable}"`)
    try {
      await db.query(`SELECT name FROM ${journalTable} LIMIT 0`)
      debug('journal', 'journal table exists — checking schema')
      await ensureSchemaUpgraded()
      bootstrapped = true
      return
    } catch (error) {
      if (isUnknownDatabaseError(error)) {
        debug('journal', 'database does not exist')
        _databaseMissing = true
        bootstrapped = true
        return
      }
    }
    debug('journal', 'creating journal table')
    try {
      await db.command(createTableSql)
    } catch (error) {
      if (isUnknownDatabaseError(error)) {
        debug('journal', 'database missing on CREATE — deferring')
        _databaseMissing = true
        bootstrapped = true
        return
      }
      throw error
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await db.query(`SELECT name FROM ${journalTable} LIMIT 0`)
        debug('journal', `DDL propagation confirmed (attempt ${attempt + 1})`)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    bootstrapped = true
  }

  async function ensureSchemaUpgraded(): Promise<void> {
    // Pre-existing journal tables predate per-operation tracking. Add the
    // columns idempotently so older deployments pick them up on first run
    // of the new chkit. ALTER ADD COLUMN IF NOT EXISTS is a metadata op,
    // no data rewrite.
    await db.command(
      `ALTER TABLE ${journalTable} ADD COLUMN IF NOT EXISTS migration_completed Bool DEFAULT true`,
    )
    await db.command(
      `ALTER TABLE ${journalTable} ADD COLUMN IF NOT EXISTS operations ${OPERATIONS_TUPLE_TYPE} DEFAULT []`,
    )
  }

  async function trySyncReplica(): Promise<void> {
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
      await ensureTable()
      if (_databaseMissing) {
        debug('journal', 'database missing — returning empty journal')
        return { version: 1, applied: [] }
      }
      await trySyncReplica()
      const rows = await db.query<MigrationRow>(
        `SELECT name, applied_at, checksum, chkit_version FROM ${journalTable} FINAL WHERE migration_completed = true ORDER BY name SETTINGS select_sequential_consistency = 1`,
      )
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
      await ensureTable()
      if (_databaseMissing) return null
      await trySyncReplica()
      const rows = await db.query<MigrationRow>(
        `SELECT name, applied_at, checksum, chkit_version, migration_completed, operations FROM ${journalTable} FINAL WHERE name = '${escapeSqlString(migrationName)}' LIMIT 1 SETTINGS select_sequential_consistency = 1`,
      )
      const row = rows[0]
      if (!row) return null
      return {
        name: row.name,
        appliedAt: row.applied_at,
        checksum: row.checksum,
        chkitVersion: row.chkit_version,
        migrationCompleted: Boolean(row.migration_completed),
        operations: (row.operations ?? []).map(operationFromTuple),
      }
    },

    async writeMigrationState(state: MigrationRowState): Promise<void> {
      if (_databaseMissing) {
        debug('journal', 'resetting databaseMissing flag — migration may have created the database')
        _databaseMissing = false
        bootstrapped = false
      }
      await ensureTable()
      const insertSql = `INSERT INTO ${journalTable} (name, applied_at, checksum, chkit_version, migration_completed, operations) VALUES ('${escapeSqlString(state.name)}', '${escapeSqlString(state.appliedAt)}', '${escapeSqlString(state.checksum)}', '${escapeSqlString(state.chkitVersion || CLI_VERSION)}', ${state.migrationCompleted ? 'true' : 'false'}, ${operationsArrayLiteral(state.operations)})`
      const maxAttempts = 5
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await db.command(insertSql)
          break
        } catch (error) {
          if (!isRetryableInsertRace(error) || attempt === maxAttempts) {
            throw error
          }
          debug('journal', `insert race detected — retrying (attempt ${attempt}/${maxAttempts})`)
          await new Promise((r) => setTimeout(r, attempt * 150))
        }
      }
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
