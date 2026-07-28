import type { MaterializedViewDefinition, SchemaDefinition, TableDefinition } from '@chkit/core'

import { extractSourceTableRef } from './chunking/sql.js'
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

/**
 * Resolve the single source table an mv_replay backfill should size its chunks
 * against — the table the materialized views read `FROM`. The injected chunk
 * conditions (`_partition_id`, sort-key ranges) run against that source, so the
 * chunk planner must introspect it rather than the target, which is
 * legitimately empty while a fresh aggregate is being bootstrapped.
 *
 * An unqualified `FROM` table defaults to the view's own database, matching
 * ClickHouse name resolution. Returns `undefined` when a source can't be
 * resolved to a single shared table — either a `FROM` we can't parse, or MVs
 * fanning in from different sources (which one chunk plan can't drive) — so the
 * caller falls back to introspecting the target, preserving multi-source replay.
 */
export function resolveMvReplaySource(
  mvs: MaterializedViewDefinition[]
): { database: string; table: string } | undefined {
  const sources = new Map<string, { database: string; table: string }>()

  for (const mv of mvs) {
    const ref = extractSourceTableRef(mv.as)
    if (!ref) return undefined
    const database = ref.database ?? mv.database
    sources.set(`${database}.${ref.table}`, { database, table: ref.table })
  }

  const distinct = [...sources.values()]
  return distinct.length === 1 ? distinct[0] : undefined
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
