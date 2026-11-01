import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { insertColumnList, table, type ColumnDefinition, type TableDefinition } from '@chkit/core'

import { IngestConfigError } from './errors.js'
import type { DestinationAdapter, Row } from './types.js'

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
 * Landing table for provider objects: a stable id plus their JSON-compatible
 * fields in a native JSON column, subject to ClickHouse JSON semantics. Typed
 * shapes are derived inside ClickHouse (views or materialized views), so changing a transform
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
      for (const column of table.columns) {
        if (/^Nested\s*\(/i.test(column.type.trim()) && rows.some((row) => column.name in row)) {
          throw new IngestConfigError(`Destination ${table.database}.${table.name}: supply Nested column "${column.name}" as flattened "${column.name}.field" arrays, not a parent field.`)
        }
      }
      const columns = insertColumnList(table)
      await executor.insert({
        table: `${table.database}.${table.name}`,
        values: rows.map(toJsonRow),
        stream: true,
        ...(columns ? { columns } : {}),
        settings: {
          insert_deduplication_token: token,
          wait_for_async_insert: 1,
          date_time_input_format: 'best_effort',
          input_format_try_infer_datetimes: 0,
        },
      })
    },
  }
}

/**
 * The JSONEachRow form of one row, also the input of content hashing. Rows are
 * encoded one at a time so a wide batch never becomes a single string. BigInt
 * becomes its exact decimal text, a non-finite number the ClickHouse float
 * literal (`nan`, `inf`, `-inf`) and a Map a plain object,
 * nested values included; plain JSON.stringify would turn them into a
 * TypeError, `null` (stored as 0) and `{}`.
 */
export function toJsonRow(row: Row): Row {
  return JSON.parse(JSON.stringify(row, encodeJsonValue)) as Row
}

function encodeJsonValue(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && !Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf'
  if (value instanceof Map) {
    const entries: Array<[string, unknown]> = []
    const keys = new Set<string>()
    for (const [key, entry] of value) {
      if (typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'bigint') {
        throw new IngestConfigError('Map keys must be strings, numbers or bigint for JSONEachRow.')
      }
      const encoded = String(key)
      if (keys.has(encoded)) throw new IngestConfigError(`Map keys collide after JSON encoding: "${encoded}".`)
      keys.add(encoded)
      entries.push([encoded, entry])
    }
    return Object.fromEntries(entries)
  }
  return value
}
