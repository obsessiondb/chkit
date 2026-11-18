import { describe, expect, test } from 'bun:test'

import { createClickHouseExecutor } from './index.js'
import { createLiveExecutor, createPrefix, getLiveEnv, quoteIdent, waitForTable } from './e2e-testkit.js'

// ObsessionDB users have no CREATE USER (or any access-management) grant
// (#430), so this test runs in verify, against the local stack, only.
const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'

// #767: a write is stored when it returns, also for a user whose profile turns
// on fire-and-forget async inserts. chkit-py sends the same setting
// (test_clickhouse_write_settings_e2e.py).
describe('@chkit/clickhouse write settings e2e (#767)', () => {
  test.skipIf(onObsessionDB)('a command is no asynchronous insert under a fire-and-forget profile', async () => {
    const env = getLiveEnv()
    const admin = createLiveExecutor(env)
    const prefix = createPrefix('write_settings')
    const user = `${prefix}user`
    const password = 'Pw-767-write-settings'
    const table = `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(`${prefix}t`)}`
    const marker = `${prefix}marker`
    try {
      await admin.command(`CREATE TABLE ${table} (id UInt64, marker String) ENGINE = MergeTree ORDER BY id`)
      await waitForTable(admin, env.clickhouseDatabase, `${prefix}t`)
      await admin.command(`CREATE USER ${quoteIdent(user)} IDENTIFIED BY '${password}' SETTINGS async_insert = 1, wait_for_async_insert = 0, async_insert_use_adaptive_busy_timeout = 0, async_insert_busy_timeout_max_ms = 30000`)
      await admin.command(`GRANT SELECT, INSERT ON ${table} TO ${quoteIdent(user)}`)
      const executor = createClickHouseExecutor({ url: env.clickhouseUrl, username: user, password, database: env.clickhouseDatabase })
      try {
        await executor.command(`INSERT INTO ${table} VALUES (1, '${marker}')`)
        // Stored when the command returned: a buffered insert would wait out
        // the profile's 30 s flush timeout.
        expect(await executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table}`)).toEqual([{ n: '1' }])
      } finally {
        await executor.close()
      }
    } finally {
      await admin.command(`DROP USER IF EXISTS ${quoteIdent(user)}`)
      await admin.command(`DROP TABLE IF EXISTS ${table} SYNC`)
      await admin.close()
    }
  }, 120_000)
})
