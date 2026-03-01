import { createClickHouseExecutor, type ClickHouseExecutor } from '@chkit/clickhouse'
import type { ChxConfig } from '@chkit/core'

export async function withClickHouseExecutor<T>(
  clickhouseConfig: NonNullable<ChxConfig['clickhouse']>,
  run: (db: ClickHouseExecutor) => Promise<T>
): Promise<T> {
  const db = createClickHouseExecutor(clickhouseConfig)
  try {
    return await run(db)
  } finally {
    await db.close()
  }
}
