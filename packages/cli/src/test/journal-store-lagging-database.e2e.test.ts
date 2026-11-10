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
 * The target as a multi-replica server looks right after CREATE DATABASE:
 * the replica that answers the reads already has the database (and no
 * journal), while the replica the journal CREATE reaches does not yet. Here
 * the database does not exist on the server at first, so the real CREATE
 * fails with UNKNOWN_DATABASE and goes through the executor's retry without
 * the database; only then does the database "propagate".
 */
function laggingReplicaExecutor(
  target: ClickHouseExecutor,
  database: string,
  propagate: () => Promise<void>,
): ClickHouseExecutor {
  let propagated = false
  return {
    ...target,
    async command(sql, settings) {
      try {
        await target.command(sql, settings)
      } catch (error) {
        if (!propagated && isUnknownDatabaseError(error)) {
          propagated = true
          await propagate()
        }
        throw error
      }
    },
    async query<T>(sql: string, settings?: Parameters<ClickHouseExecutor['query']>[1]): Promise<T[]> {
      if (!propagated) {
        if (sql.startsWith('SELECT currentDatabase()')) return [{ database }] as T[]
        if (sql.startsWith('SELECT name, migration_completed, operations FROM ')) {
          throw Object.assign(new Error('Table does not exist. (UNKNOWN_TABLE)'), { code: '60' })
        }
      }
      return await target.query<T>(sql, settings)
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
        const db = laggingReplicaExecutor(target, database, () => admin.command(`CREATE DATABASE ${quoteIdent(database)}`))
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

  test(
    'a journal INSERT that reaches a replica without the database never lands in default (#700)',
    async () => {
      const admin = createLiveExecutor(liveEnv)
      const database = `${createPrefix('lagging_insert')}db`
      const journalTable = createJournalTableName('lagging_insert')
      const previousJournalTable = process.env.CHKIT_JOURNAL_TABLE
      process.env.CHKIT_JOURNAL_TABLE = journalTable
      const connection = { url: liveEnv.clickhouseUrl, username: liveEnv.clickhouseUser, password: liveEnv.clickhousePassword }
      const target = createClickHouseExecutor({ ...connection, database })
      // A replica that has not applied CREATE DATABASE yet: its requests fail
      // with UNKNOWN_DATABASE, and the executor retries them without it.
      const lagging = createClickHouseExecutor({ ...connection, database: `${database}_lagging` })
      const journal = `${quoteIdent(database)}.${quoteIdent(journalTable)}`
      const strayJournal = `${quoteIdent(SERVER_DEFAULT_DATABASE)}.${quoteIdent(journalTable)}`
      const state = {
        name: 'second.sql',
        appliedAt: '2026-11-10 12:00:00.000',
        checksum: 'cs',
        chkitVersion: 'v',
        migrationCompleted: true,
        operations: [],
      }

      try {
        await admin.command(`CREATE DATABASE ${quoteIdent(database)}`)
        await createJournalStore(target).writeMigrationState({ ...state, name: 'first.sql' })
        // A compatible journal in default, as another project or #493 left one.
        await admin.command(`CREATE TABLE ${strayJournal} AS ${journal}`)

        const db: ClickHouseExecutor = {
          ...target,
          command: (sql, settings) =>
            sql.startsWith('INSERT INTO') ? lagging.command(sql, settings) : target.command(sql, settings),
        }
        await createJournalStore(db).writeMigrationState(state)

        const stray = await admin.query<{ rows: string }>(`SELECT count() AS rows FROM ${strayJournal}`)
        expect(Number(stray[0]?.rows)).toBe(0)
        const rows = await waitForRows<{ name: string }>(
          admin,
          `SELECT name FROM ${journal} FINAL ORDER BY name SETTINGS select_sequential_consistency = 1`,
          (found) => found.length === 2,
          'both journal rows in the target database',
        )
        expect(rows).toEqual([{ name: 'first.sql' }, { name: 'second.sql' }])
      } finally {
        if (previousJournalTable === undefined) delete process.env.CHKIT_JOURNAL_TABLE
        else process.env.CHKIT_JOURNAL_TABLE = previousJournalTable
        await admin.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`).catch(() => {})
        await admin.command(`DROP TABLE IF EXISTS ${strayJournal} SYNC`).catch(() => {})
        await lagging.close()
        await target.close()
        await admin.close()
      }
    },
    60_000,
  )
})
