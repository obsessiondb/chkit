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
