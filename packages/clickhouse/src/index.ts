import { createClient } from '@clickhouse/client'
import type { ChxConfig } from '@chx/core'

export interface ClickHouseExecutor {
  execute(sql: string): Promise<void>
  query<T>(sql: string): Promise<T[]>
}

export function createClickHouseExecutor(config: NonNullable<ChxConfig['clickhouse']>): ClickHouseExecutor {
  const client = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    clickhouse_settings: {
      wait_end_of_query: 1,
    },
  })

  return {
    async execute(sql: string): Promise<void> {
      await client.command({ query: sql })
    },
    async query<T>(sql: string): Promise<T[]> {
      const result = await client.query({ query: sql, format: 'JSONEachRow' })
      return result.json<T>()
    },
  }
}
