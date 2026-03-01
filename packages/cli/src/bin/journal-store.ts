import { createClickHouseExecutor, type ClickHouseExecutor } from '@chkit/clickhouse'
import type { ChxConfig } from '@chkit/core'

import type { MigrationJournal, MigrationJournalEntry } from './migration-store.js'
import { CLI_VERSION } from './version.js'

export interface JournalStore {
  readJournal(): Promise<MigrationJournal>
  appendEntry(entry: MigrationJournalEntry): Promise<void>
}

const DEFAULT_JOURNAL_TABLE = '_chkit_migrations'
const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function formatIdentifier(value: string): string {
  if (SIMPLE_IDENTIFIER.test(value)) return value
  return `\`${value.replace(/`/g, '``')}\``
}

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
  const journalTable = formatIdentifier(resolveJournalTableName())
  const createTableSql = `CREATE TABLE IF NOT EXISTS ${journalTable} (
    name String,
    applied_at DateTime64(3, 'UTC'),
    checksum String,
    chkit_version String
) ENGINE = MergeTree()
ORDER BY (name)
SETTINGS index_granularity = 1`
  let bootstrapped = false

  async function ensureTable(): Promise<void> {
    if (bootstrapped) return
    // Probe whether the table already exists before issuing CREATE TABLE.
    // On ClickHouse Cloud, repeated CREATE TABLE IF NOT EXISTS can fail with
    // "already exists in metadata backend with different schema" because the
    // engine normalisation (SharedMergeTree vs SharedMergeTree()) differs
    // between the stored metadata and the new DDL statement.
    try {
      await db.query(`SELECT name FROM ${journalTable} LIMIT 0`)
      bootstrapped = true
      return
    } catch {
      // Table does not exist yet – create it below.
    }
    await db.execute(createTableSql)
    // On ClickHouse Cloud, DDL propagation across nodes may lag behind the
    // CREATE TABLE acknowledgment. Wait until the table is queryable.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await db.query(`SELECT name FROM ${journalTable} LIMIT 0`)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    bootstrapped = true
  }

  return {
    async readJournal(): Promise<MigrationJournal> {
      await ensureTable()
      try {
        await db.execute(`SYSTEM SYNC REPLICA ${journalTable}`)
      } catch {
        // Non-replicated or single-node setups don't support SYSTEM SYNC REPLICA.
      }
      const rows = await db.query<MigrationRow>(
        `SELECT name, applied_at, checksum, chkit_version FROM ${journalTable} ORDER BY name SETTINGS select_sequential_consistency = 1`
      )
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
      await ensureTable()
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const insertSql = `INSERT INTO ${journalTable} (name, applied_at, checksum, chkit_version) VALUES ('${esc(entry.name)}', '${esc(entry.appliedAt)}', '${esc(entry.checksum)}', '${esc(CLI_VERSION)}')`
      const maxAttempts = 5
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await db.execute(insertSql)
          break
        } catch (error) {
          if (!isRetryableInsertRace(error) || attempt === maxAttempts) {
            throw error
          }
          await new Promise((r) => setTimeout(r, attempt * 150))
        }
      }
      try {
        await db.execute(`SYSTEM SYNC REPLICA ${journalTable}`)
      } catch {
        // Non-replicated or single-node setups don't support SYSTEM SYNC REPLICA.
      }
    },
  }
}

export function createJournalStoreFromConfig(
  clickhouseConfig: NonNullable<ChxConfig['clickhouse']>
): { journalStore: JournalStore; db: ClickHouseExecutor } {
  const db = createClickHouseExecutor(clickhouseConfig)
  return { journalStore: createJournalStore(db), db }
}
