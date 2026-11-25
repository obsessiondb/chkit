import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { insertColumnList, insertableColumnNames, table, type ColumnDefinition, type TableDefinition } from '@chkit/core'

import type { DestinationAdapter, Row } from './types.js'

export const BATCH_ID_COLUMN = '_chkit_batch_id'
export const RUN_ID_COLUMN = '_chkit_run_id'
export const INGESTED_AT_COLUMN = '_chkit_ingested_at'
export const REST_COLUMN = '_chkit_rest'

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
      const columns = insertColumnList(table)
      await executor.insert({
        table: `${table.database}.${table.name}`,
        values: toJsonRows(rows),
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
 * - Top-level keys the INSERT does not accept move into the table's `_chkit_rest` column as
 *   `{ field: value }`; without that column they fail the stream. Keys inside values are untouched.
 * - Returns the moved field names; rows without unknown keys are returned as they are.
 */
export function moveUnknownFields(streamId: string, table: TableDefinition, rows: readonly Row[]): { rows: Row[]; fields: string[] } {
  const name = `${table.database}.${table.name}`
  const accepted = new Set([...insertableColumnNames(table), BATCH_ID_COLUMN, RUN_ID_COLUMN, INGESTED_AT_COLUMN])
  const nested = new Set(table.columns.filter((column) => /^Nested\s*\(/i.test(column.type.trim())).map((column) => column.name))
  const unknown = new Set<string>()
  const shaped = rows.map((row) => {
    const extras: [string, unknown][] = []
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined || (accepted.has(key) && key !== REST_COLUMN)) continue
      if (key === REST_COLUMN) throw new Error(`Stream "${streamId}" sets ${REST_COLUMN} on a row for ${name}; ChKit fills it with the fields the table has no column for.`)
      if (nested.has(key)) throw new Error(`Destination ${name}: supply Nested column "${key}" as flattened "${key}.field" arrays, not a parent field.`)
      extras.push([key, value])
      unknown.add(key)
    }
    if (extras.length === 0) return row
    return { ...Object.fromEntries(Object.entries(row).filter(([key]) => accepted.has(key))), [REST_COLUMN]: Object.fromEntries(extras) }
  })
  const fields = [...unknown].sort()
  if (fields.length > 0 && !accepted.has(REST_COLUMN)) {
    throw new Error(`Stream "${streamId}" yielded fields ${name} has no column for: ${fields.join(', ')}. Map them to columns, or add a JSON column ${REST_COLUMN} to keep them.`)
  }
  return { rows: shaped, fields }
}

/** - Encode rows individually, including nested bigint, non-finite floats and Maps. */
export function toJsonRows(rows: readonly Row[]): Row[] {
  return rows.map(toJsonRow)
}

/** - One shared JSON representation for row transport and content hashing. */
export function toJsonRow(row: Row): Row {
  return JSON.parse(JSON.stringify(row, encodeJsonValue)) as Row
}

function encodeJsonValue(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && !Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf'
  if (value instanceof Map) {
    const entries = new Map<string, unknown>()
    for (const [key, entry] of value) {
      if (typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'bigint') {
        throw new Error('Map keys must be strings, numbers or bigint for JSONEachRow.')
      }
      const encoded = String(key)
      if (entries.has(encoded)) throw new Error(`Map keys collide after JSON encoding: "${encoded}".`)
      entries.set(encoded, entry)
    }
    return Object.fromEntries(entries)
  }
  return value
}
