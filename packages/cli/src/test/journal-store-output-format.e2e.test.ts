import { describe, expect, test } from 'bun:test'

import { createClickHouseExecutor } from '@chkit/clickhouse'

import { createJournalStore, type MigrationRowState } from '../runtime/journal-store.js'
import { createPrefix, getLiveEnv, quoteIdent } from './e2e-testkit.js'

// #672: a user profile can set date_time_output_format, which changes how a
// DateTime64 is rendered in a result and inside toJSONString. The journal reads
// its times the same way under every format.

const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/

describe('journal reads under date_time_output_format (#672)', () => {
  test("reads applied_at and the operations' times as 'YYYY-MM-DD HH:MM:SS.mmm' with unix_timestamp", async () => {
    const env = getLiveEnv()
    const database = `${createPrefix('journal_fmt')}db`
    const admin = createClickHouseExecutor({
      url: env.clickhouseUrl,
      username: env.clickhouseUser,
      password: env.clickhousePassword,
      database: env.clickhouseDatabase,
    })
    const url = new URL(env.clickhouseUrl)
    // @clickhouse/client sends clickhouse_setting_* URL parameters as settings.
    url.searchParams.set('clickhouse_setting_date_time_output_format', 'unix_timestamp')
    const db = createClickHouseExecutor({
      url: url.toString(),
      username: env.clickhouseUser,
      password: env.clickhousePassword,
      database,
    })
    try {
      await admin.command(`CREATE DATABASE ${quoteIdent(database)}`)
      const [probe] = await db.query<{ t: string }>("SELECT toDateTime64('2026-05-26 10:00:00.123', 3, 'UTC') AS t")
      // The setting reaches the server: without the fix the journal reads this form.
      expect(probe?.t).toBe('1779789600.123')

      const store = createJournalStore(db)
      const state: MigrationRowState = {
        name: 'm.sql',
        appliedAt: '2026-05-26T10:00:01.000',
        checksum: 'abc',
        chkitVersion: '',
        migrationCompleted: false,
        operations: [
          {
            operationIndex: 0,
            operationKey: 'table:t',
            operationType: 'load_table_data',
            queryId: 'q',
            status: 'started',
            startedAt: '2026-05-26T10:00:00.123',
            finishedAt: null,
            lastError: '',
            fingerprint: '',
          },
        ],
      }
      await store.writeMigrationState(state)

      const read = await createJournalStore(db).readMigrationState('m.sql')
      expect(read?.appliedAt).toBe('2026-05-26 10:00:01.000')
      expect(read?.operations[0]?.startedAt).toBe('2026-05-26 10:00:00.123')
      expect(read?.operations[0]?.startedAt).toMatch(TIME)
    } finally {
      await admin.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
      await db.close()
      await admin.close()
    }
  }, 120_000)
})
