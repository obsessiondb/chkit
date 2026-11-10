import { describe, expect, test } from 'bun:test'

import { createClickHouseExecutor, isUnknownDatabaseError, type ClickHouseExecutor } from '@chkit/clickhouse'

import { createJournalStore } from '../runtime/journal-store.js'
import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  getLiveEnv,
  quoteIdent,
  waitForRows,
} from './e2e-testkit.js'

// The executor retries a statement that fails with UNKNOWN_DATABASE without
// the database, so that is where a misplaced journal would land (#493).
const SERVER_DEFAULT_DATABASE = 'default'

/**
 * The target as a multi-replica server looks right after CREATE DATABASE: the
 * replica that answers the journal probe already has the database (and no
 * journal), while the replica the next request reaches does not yet. Here the
 * database does not exist on the server at first, so every real request fails
 * with UNKNOWN_DATABASE, until the first such failure "propagates" it.
 */
function laggingReplicaExecutor(target: ClickHouseExecutor, propagate: () => Promise<void>): ClickHouseExecutor {
  let propagated = false
  async function lagging<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (!propagated && isUnknownDatabaseError(error)) {
        propagated = true
        await propagate()
      }
      throw error
    }
  }
  return {
    ...target,
    command: (sql, settings) => lagging(() => target.command(sql, settings)),
    async query<T>(sql: string, settings?: Parameters<ClickHouseExecutor['query']>[1]): Promise<T[]> {
      if (!propagated && /^SELECT name, migration_completed, operations FROM /.test(sql)) {
        throw Object.assign(new Error('Table does not exist. (UNKNOWN_TABLE)'), { code: '60' })
      }
      return await lagging(() => target.query<T>(sql, settings))
    },
  }
}

describe('journal store while CREATE DATABASE is still reaching replicas', () => {
  const liveEnv = getLiveEnv()

  test(
    'creates the journal in the target database, never in default (#493)',
    async () => {
      const admin = createLiveExecutor(liveEnv)
      const database = `${createPrefix('lagging_db')}db`
      const journalTable = createJournalTableName('lagging_db')
      const previousJournalTable = process.env.CHKIT_JOURNAL_TABLE
      process.env.CHKIT_JOURNAL_TABLE = journalTable
      const target = createClickHouseExecutor({
        url: liveEnv.clickhouseUrl,
        username: liveEnv.clickhouseUser,
        password: liveEnv.clickhousePassword,
        database,
      })
      const strayJournal = `${quoteIdent(SERVER_DEFAULT_DATABASE)}.${quoteIdent(journalTable)}`

      try {
        const db = laggingReplicaExecutor(target, () => admin.command(`CREATE DATABASE ${quoteIdent(database)}`))
        const store = createJournalStore(db)
        await store.writeMigrationState({
          name: 'bootstrap.sql',
          appliedAt: '2026-11-10 12:00:00.000',
          checksum: 'cs',
          chkitVersion: 'v',
          migrationCompleted: true,
          operations: [],
        })

        const stray = await admin.query<{ tables: string }>(
          `SELECT count() AS tables FROM system.tables WHERE database = '${SERVER_DEFAULT_DATABASE}' AND name = '${journalTable}'`,
        )
        expect(Number(stray[0]?.tables)).toBe(0)
        expect(store.databaseMissing).toBe(false)
        const journal = await waitForRows<{ name: string }>(
          admin,
          `SELECT name FROM ${quoteIdent(database)}.${quoteIdent(journalTable)} FINAL SETTINGS select_sequential_consistency = 1`,
          (rows) => rows.length === 1,
          'journal row in the target database',
        )
        expect(journal).toEqual([{ name: 'bootstrap.sql' }])
      } finally {
        if (previousJournalTable === undefined) delete process.env.CHKIT_JOURNAL_TABLE
        else process.env.CHKIT_JOURNAL_TABLE = previousJournalTable
        await admin.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`).catch(() => {})
        await admin.command(`DROP TABLE IF EXISTS ${strayJournal} SYNC`).catch(() => {})
        await target.close()
        await admin.close()
      }
    },
    60_000,
  )
})
