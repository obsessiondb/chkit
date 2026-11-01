import { describe, expect, test } from 'bun:test'

import { createLiveExecutor, createPrefix, getLiveEnv, pollUntil, quoteIdent, waitForTable } from './e2e-testkit.js'

describe('@chkit/clickhouse queryStatus e2e (#436)', () => {
  test('reports the counts of a finished INSERT as numbers', async () => {
    const env = getLiveEnv()
    const executor = createLiveExecutor(env)
    const table = `${createPrefix('query_status')}t`
    const object = `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(table)}`
    try {
      await executor.command(`CREATE TABLE ${object} (id UInt64) ENGINE = MergeTree ORDER BY id`)
      await waitForTable(executor, env.clickhouseDatabase, table)
      const queryId = crypto.randomUUID()
      await executor.submit(`INSERT INTO ${object} SELECT number FROM numbers(1000)`, queryId)

      const status = await pollUntil(
        () => executor.queryStatus(queryId),
        (found) => found.status === 'finished',
        { timeoutMs: 60_000 },
      )
      // A UInt64 column of 1000 rows is 8000 bytes.
      expect(status).toEqual({
        status: 'finished',
        writtenRows: 1000,
        writtenBytes: 8000,
        durationMs: expect.any(Number),
      })
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${object} SYNC`)
      await executor.close()
    }
  }, 120_000)
})
