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

  // #767: a statement the server rejected before it started is logged as
  // ExceptionBeforeStart. Only a caller whose id names one attempt alone asks
  // for it: backfill reuses chunk ids, and an old rejection must not read as
  // the outcome of a later attempt of the same id.
  test('counts an ExceptionBeforeStart entry only when asked to', async () => {
    const env = getLiveEnv()
    const executor = createLiveExecutor(env)
    const queryId = crypto.randomUUID()
    try {
      await expect(executor.submit('SELEC 1', queryId)).rejects.toThrow(/SYNTAX_ERROR|Syntax error/)
      const failed = await pollUntil(
        () => executor.queryStatus(queryId, { includeBeforeStart: true }),
        (found) => found.status === 'failed',
        { timeoutMs: 60_000 },
      )
      expect(failed).toMatchObject({ status: 'failed', beforeStart: true, error: expect.stringContaining('SYNTAX_ERROR') })
      expect(await executor.queryStatus(queryId)).toEqual({ status: 'unknown' })
    } finally {
      await executor.close()
    }
  }, 120_000)
})
