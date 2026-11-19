import { expect, test } from 'bun:test'
import { createClickHouseExecutor } from '@chkit/clickhouse'

test('repro: refused submit error shape', async () => {
  const db = createClickHouseExecutor({ url: 'http://127.0.0.1:1', username: 'default', password: '', database: 'default' } as never)
  const error = await db.submit('SELECT 1', 'x').catch((e: unknown) => e)
  console.log(error, (error as { code?: string }).code, (error as Error).cause)
  expect(error).toBeInstanceOf(Error)
})
