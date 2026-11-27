import { expect, test } from 'bun:test'

import fixture from '../../../test/fixtures/quoted-escapes.json'
import { createLiveExecutor, getLiveEnv } from './e2e-testkit.js'

// The server reads every name and string in test/fixtures/quoted-escapes.json
// as the fixture says, so the lexer tests that share it (both ports) hold
// against ClickHouse itself (#639).
test('ClickHouse reads the escapes in quoted names and strings as the shared fixture says', async () => {
  const executor = createLiveExecutor(getLiveEnv())
  const read: Array<{ sql: string; value: string | undefined }> = []
  for (const { sql } of fixture.cases) {
    const rows = sql.startsWith("'")
      ? (await executor.query<{ v: string }>(`SELECT ${sql} AS v`)).map((row) => row.v)
      : (await executor.query<{ name: string }>(`DESCRIBE (SELECT 1 AS ${sql})`)).map((row) => row.name)
    read.push({ sql, value: rows[0] })
  }
  await executor.close()
  expect(read).toEqual(fixture.cases.map(({ sql, value }) => ({ sql, value })))
}, 60_000)
