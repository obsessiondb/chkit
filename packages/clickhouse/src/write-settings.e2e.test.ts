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
        // The insert API too; chkit-py sends the same (#767, round 4).
        await executor.insert({ table: `${env.clickhouseDatabase}.${prefix}t`, values: [{ id: 2, marker }] })
        expect(await executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table}`)).toEqual([{ n: '2' }])
        // And submit, which async migrate statements go through (#790).
        await executor.submit(`INSERT INTO ${table} VALUES (3, '${marker}')`)
        expect(await executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table}`)).toEqual([{ n: '3' }])
      } finally {
        await executor.close()
      }
    } finally {
      await admin.command(`DROP USER IF EXISTS ${quoteIdent(user)}`)
      await admin.command(`DROP TABLE IF EXISTS ${table} SYNC`)
      await admin.close()
    }
  }, 120_000)

  // #790: a table's own async_insert setting makes an INSERT asynchronous even
  // with async_insert = 0 in the query; it is stored when it returns only
  // because it waits for the flush.
  test.skipIf(onObsessionDB)('a write into a table that turns on async inserts waits for the flush', async () => {
    const env = getLiveEnv()
    const admin = createLiveExecutor(env)
    const prefix = createPrefix('write_settings_table')
    const user = `${prefix}user`
    const password = 'Pw-790-write-settings'
    const table = `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(`${prefix}t`)}`
    try {
      await admin.command(`CREATE TABLE ${table} (id UInt64) ENGINE = MergeTree ORDER BY id SETTINGS async_insert = 1`)
      await waitForTable(admin, env.clickhouseDatabase, `${prefix}t`)
      await admin.command(`CREATE USER ${quoteIdent(user)} IDENTIFIED BY '${password}' SETTINGS wait_for_async_insert = 0, async_insert_use_adaptive_busy_timeout = 0, async_insert_busy_timeout_max_ms = 3000`)
      await admin.command(`GRANT SELECT, INSERT ON ${table} TO ${quoteIdent(user)}`)
      const executor = createClickHouseExecutor({ url: env.clickhouseUrl, username: user, password, database: env.clickhouseDatabase })
      try {
        await executor.command(`INSERT INTO ${table} VALUES (1)`)
        expect(await executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table}`)).toEqual([{ n: '1' }])
        await executor.submit(`INSERT INTO ${table} VALUES (2)`)
        expect(await executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table}`)).toEqual([{ n: '2' }])
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
