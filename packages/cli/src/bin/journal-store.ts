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
    bootstrapped = true
  }

  return {
    async readJournal(): Promise<MigrationJournal> {
      await ensureTable()
      const rows = await db.query<MigrationRow>(
        `SELECT name, applied_at, checksum, chkit_version FROM _chkit_migrations ORDER BY name`
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
      await db.insert<MigrationRow>({
        table: '_chkit_migrations',
        values: [
          {
            name: entry.name,
            applied_at: entry.appliedAt,
            checksum: entry.checksum,
            chkit_version: CLI_VERSION,
          },
        ],
      })
    },
  }
}

export function createJournalStoreFromConfig(
  clickhouseConfig: NonNullable<ChxConfig['clickhouse']>
): { journalStore: JournalStore; db: ClickHouseExecutor } {
  const db = createClickHouseExecutor(clickhouseConfig)
  return { journalStore: createJournalStore(db), db }
}
