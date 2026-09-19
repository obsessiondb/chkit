import type { ClickHouseExecutor } from '@chkit/clickhouse'
import type { ColumnDefinition } from '@chkit/core'

import type { DestinationAdapter } from './types.js'

export const BATCH_ID_COLUMN = '_chkit_batch_id'
export const RUN_ID_COLUMN = '_chkit_run_id'
export const INGESTED_AT_COLUMN = '_chkit_ingested_at'

/**
 * Runtime-owned metadata every ingestion destination table carries. Spread it
 * into the table's `columns`. `_chkit_ingested_at` is destination-owned: it is
 * never sent by the loader, so it records the physical publication time even
 * when a retry recomputes it under the same deduplication token.
 */
export const ingestionColumns: readonly ColumnDefinition[] = [
  { name: BATCH_ID_COLUMN, type: 'String' },
  { name: RUN_ID_COLUMN, type: 'String' },
  { name: INGESTED_AT_COLUMN, type: "DateTime64(6, 'UTC')", default: 'fn:now64(6)' },
]

/**
 * A successful synchronous insert response (or an awaited async insert) is the
 * sink evidence ChKit trusts. A missing response stays ambiguous and is retried
 * with the same token.
 */
export function createClickHouseDestination(executor: ClickHouseExecutor): DestinationAdapter {
  return {
    async insert({ table, rows, token }) {
      if (rows.length === 0) return
      await executor.insert({
        table: `${table.database}.${table.name}`,
        values: [...rows],
        settings: {
          insert_deduplication_token: token,
          wait_for_async_insert: 1,
        },
      })
    },
  }
}
