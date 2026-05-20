import { isUnknownDatabaseError, type ClickHouseExecutor } from '@chkit/clickhouse'

import type { MigrationJournal, MigrationJournalEntry } from './migration-store.js'
import { CLI_VERSION } from './version.js'
import { debug } from './debug.js'

interface JournalStore {
  readJournal(): Promise<MigrationJournal>
  appendEntry(entry: MigrationJournalEntry): Promise<void>
  readonly databaseMissing: boolean
}

const DEFAULT_JOURNAL_TABLE = '_chkit_migrations'

function resolveJournalTableName(): string {
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
}

function isRetryableInsertRace(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message
  return message.includes('INSERT race condition') || message.includes('Please retry the INSERT')
}

export function createJournalStore(db: ClickHouseExecutor): JournalStore {
  const journalTable = resolveJournalTableName()
  debug('journal', `journal table: ${journalTable}${process.env.CHKIT_JOURNAL_TABLE ? ' (from CHKIT_JOURNAL_TABLE)' : ''}`)
  const createTableSql = `CREATE TABLE IF NOT EXISTS ${journalTable} (
    name String,
    applied_at DateTime64(3, 'UTC'),
    checksum String,
    chkit_version String
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
      debug('journal', 'journal table exists')
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
      try {
        await db.command(`SYSTEM SYNC REPLICA ${journalTable}`)
      } catch {
        // Non-replicated or single-node setups don't support SYSTEM SYNC REPLICA.
      }
      const rows = await db.query<MigrationRow>(
        `SELECT name, applied_at, checksum, chkit_version FROM ${journalTable} ORDER BY name SETTINGS select_sequential_consistency = 1`
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

    async appendEntry(entry: MigrationJournalEntry): Promise<void> {
      debug('journal', `appending entry: ${entry.name} (checksum: ${entry.checksum})`)
      if (_databaseMissing) {
        debug('journal', 'resetting databaseMissing flag — migration may have created the database')
        _databaseMissing = false
        bootstrapped = false
      }
      await ensureTable()
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const insertSql = `INSERT INTO ${journalTable} (name, applied_at, checksum, chkit_version) VALUES ('${esc(entry.name)}', '${esc(entry.appliedAt)}', '${esc(entry.checksum)}', '${esc(CLI_VERSION)}')`
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
      try {
        await db.command(`SYSTEM SYNC REPLICA ${journalTable}`)
      } catch {
        // Non-replicated or single-node setups don't support SYSTEM SYNC REPLICA.
      }
    },
  }
}
