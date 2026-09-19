import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { table, type ColumnDefinition, type TableDefinition } from '@chkit/core'

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

// A type alias (not an interface) so it is assignable to the index-signature Row type.
export type RawRow = {
  id: string
  raw: unknown
}

/**
 * Landing table for provider objects exactly as received: a stable id plus the
 * untouched object in a native JSON column. Typed shapes are derived from it
 * inside ClickHouse (views or materialized views), so changing a transform
 * never requires re-fetching the source. Replays and overlapping windows
 * collapse to the latest ingested version of each id.
 */
export function rawTable(input: { database: string; name: string; comment?: string }): TableDefinition {
  return table({
    database: input.database,
    name: input.name,
    comment: input.comment,
    columns: [{ name: 'id', type: 'String' }, { name: 'raw', type: 'JSON' }, ...ingestionColumns],
    engine: `ReplacingMergeTree(${INGESTED_AT_COLUMN})`,
    primaryKey: ['id'],
    orderBy: ['id'],
  })
}

/** Shape provider objects for a {@link rawTable} without mapping their fields. */
export function rawRows<T>(items: readonly T[], id: (item: T) => string): RawRow[] {
  return items.map((item) => ({ id: id(item), raw: item }))
}

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
