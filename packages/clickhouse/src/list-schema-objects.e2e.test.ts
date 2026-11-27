import { describe, expect, test } from 'bun:test'

import { createLiveExecutor, createPrefix, getLiveEnv, quoteIdent, waitForTable } from './e2e-testkit.js'

describe('@chkit/clickhouse listSchemaObjects e2e', () => {
  test('hides only names that start with _chkit_', async () => {
    const env = getLiveEnv()
    const executor = createLiveExecutor(env)
    const database = env.clickhouseDatabase
    const prefix = createPrefix('list_objects')
    // The old filter, LIKE '_chkit_%', also hid this name: `_` matches any character.
    const kept = `x${prefix}t`
    const hidden = `_${prefix}t`
    try {
      for (const name of [kept, hidden]) {
        await executor.command(
          `CREATE TABLE ${quoteIdent(database)}.${quoteIdent(name)} (x UInt64) ENGINE = MergeTree ORDER BY x`,
        )
      }
      await waitForTable(executor, database, kept)
      await waitForTable(executor, database, hidden)
      const names = (await executor.listSchemaObjects()).map((object) => object.name)
      expect(names).toContain(kept)
      expect(names).not.toContain(hidden)
    } finally {
      for (const name of [kept, hidden]) {
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(name)}`)
      }
      await executor.close()
    }
  })
})

test('refresh backing tables are hidden only for an owning MV in the same database', async () => {
  const db = createLiveExecutor(getLiveEnv())
  const database = createPrefix('refresh_objects')
  try {
    await db.command(`CREATE DATABASE ${quoteIdent(database)}`)
    await db.command(`CREATE MATERIALIZED VIEW ${quoteIdent(database)}.mv REFRESH AFTER 1 DAY ENGINE=MergeTree ORDER BY id EMPTY AS SELECT number AS id FROM numbers(3)`)
    const [{ uuid }] = await db.query<{ uuid: string }>(`SELECT toString(uuid) AS uuid FROM system.tables WHERE database='${database}' AND name='mv'`)
    const inner = `.inner_id.${uuid}`
    const temporary = `.tmp.inner_id.${uuid}`
    // A stale replacement table can outlive a refresh. Use its exact name,
    // with a real owning MV, without depending on the refresh's timing.
    await db.command(`SYSTEM STOP VIEW ${quoteIdent(database)}.mv`)
    await db.command(`CREATE TABLE IF NOT EXISTS ${quoteIdent(database)}.${quoteIdent(temporary)} (id UInt64) ENGINE=Memory`)
    const orphan = '.tmp.inner_id.00000000-0000-0000-0000-000000000001'
    const lookalike = `${temporary}_user`
    for (const name of [orphan, lookalike]) {
      await db.command(`CREATE TABLE ${quoteIdent(database)}.${quoteIdent(name)} (id UInt64) ENGINE=Memory`)
    }
    const raw = await db.query<{ name: string }>(`SELECT name FROM system.tables WHERE database='${database}'`)
    expect(raw.map((row) => row.name)).toContain(inner)
    expect(raw.map((row) => row.name)).toContain(temporary)
    const objects = (await db.listSchemaObjects()).filter((object) => object.database === database)
    expect(objects.map((object) => object.name).sort()).toEqual([orphan, lookalike, 'mv'].sort())
  } finally {
    await db.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
    await db.close()
  }
})
