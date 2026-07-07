import type { MaterializedViewDefinition, SchemaDefinition, TableDefinition } from '@chkit/core'

import './table-config.js'
import type { TimeColumnCandidate } from './types.js'

const DATETIME_TYPES = new Set(['DateTime', 'DateTime64'])

const COMMON_TIME_COLUMN_NAMES = new Set([
  'created_at',
  'timestamp',
  'ingested_at',
  'event_time',
  'event_at',
  'occurred_at',
])

function isDateTimeType(type: string): boolean {
  if (DATETIME_TYPES.has(type)) return true
  if (type.startsWith('DateTime64(')) return true
  if (type.startsWith("DateTime('")) return true
  return false
}

/**
 * Return every materialized view whose `to` target is `database.table`.
 * ClickHouse allows several MVs to feed the same destination table, so an
 * mv_replay backfill must replay all of them — returning only the first would
 * silently drop the rest.
 */
export function findMvsForTarget(
  definitions: SchemaDefinition[],
  database: string,
  table: string
): MaterializedViewDefinition[] {
  return definitions.filter(
    (def): def is MaterializedViewDefinition =>
      def.kind === 'materialized_view' &&
      def.to.database === database &&
      def.to.name === table
  )
}

export function findTableForTarget(
  definitions: SchemaDefinition[],
  database: string,
  table: string
): TableDefinition | undefined {
  for (const def of definitions) {
    if (def.kind === 'table' && def.database === database && def.name === table) {
      return def
    }
  }

  for (const def of definitions) {
    if (
      def.kind === 'materialized_view' &&
      def.to.database === database &&
      def.to.name === table
    ) {
      for (const sourceDef of definitions) {
        if (sourceDef.kind === 'table' && sourceDef.database === def.database) {
          return sourceDef
        }
      }
    }
  }

  return undefined
}

export function detectCandidatesFromTable(table: TableDefinition): TimeColumnCandidate[] {
  const candidates: TimeColumnCandidate[] = []
  const seen = new Set<string>()

  const orderByColumns = new Set(table.orderBy)
  for (const col of table.columns) {
    if (orderByColumns.has(col.name) && isDateTimeType(col.type)) {
      candidates.push({ name: col.name, type: col.type, source: 'order_by' })
      seen.add(col.name)
    }
  }

  for (const col of table.columns) {
    if (seen.has(col.name)) continue
    if (COMMON_TIME_COLUMN_NAMES.has(col.name) && isDateTimeType(col.type)) {
      candidates.push({ name: col.name, type: col.type, source: 'column_scan' })
      seen.add(col.name)
    }
  }

  return candidates
}

export function extractSchemaTimeColumn(table: TableDefinition): string | undefined {
  return table.plugins?.backfill?.timeColumn
}
