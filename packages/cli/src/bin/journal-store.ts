import { createClickHouseExecutor, type ClickHouseExecutor } from '@chkit/clickhouse'
import type { ChxConfig } from '@chkit/core'

import type { MigrationJournal, MigrationJournalEntry } from './migration-store.js'
import { CLI_VERSION } from './version.js'

export interface JournalStore {
  readJournal(): Promise<MigrationJournal>
  appendEntry(entry: MigrationJournalEntry): Promise<void>
}

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS _chkit_migrations (
    name String,
    applied_at DateTime64(3, 'UTC'),
    checksum String,
    chkit_version String
) ENGINE = MergeTree()
ORDER BY (name)
SETTINGS index_granularity = 1`

interface MigrationRow extends Record<string, unknown> {
  name: string
  applied_at: string
  checksum: string
  chkit_version: string
}

export function createJournalStore(db: ClickHouseExecutor): JournalStore {
  let bootstrapped = false

  async function ensureTable(): Promise<void> {
    if (bootstrapped) return
    await db.execute(CREATE_TABLE_SQL)
    // On ClickHouse Cloud, DDL propagation across nodes may lag behind the
    // CREATE TABLE acknowledgment. Wait until the table is queryable.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await db.query(`SELECT name FROM _chkit_migrations LIMIT 0`)
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
        await db.execute(`SYSTEM SYNC REPLICA _chkit_migrations`)
      } catch {
        // Non-replicated or single-node setups don't support SYSTEM SYNC REPLICA.
      }
      const rows = await db.query<MigrationRow>(
        `SELECT name, applied_at, checksum, chkit_version FROM _chkit_migrations ORDER BY name SETTINGS select_sequential_consistency = 1`
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
      await db.execute(
        `INSERT INTO _chkit_migrations (name, applied_at, checksum, chkit_version) VALUES ('${esc(entry.name)}', '${esc(entry.appliedAt)}', '${esc(entry.checksum)}', '${esc(CLI_VERSION)}')`
      )
      try {
        await db.execute(`SYSTEM SYNC REPLICA _chkit_migrations`)
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
