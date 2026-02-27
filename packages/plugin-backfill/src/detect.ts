import { dirname } from 'node:path'

import { loadSchemaDefinitions } from '@chkit/core'
import type { SchemaDefinition, TableDefinition } from '@chkit/core'

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

export async function loadTimeColumnInfo(
  target: string,
  schemaGlobs: string | string[],
  configPath: string
): Promise<{ schemaTimeColumn: string | undefined; candidates: TimeColumnCandidate[] }> {
  let definitions: SchemaDefinition[]
  try {
    definitions = await loadSchemaDefinitions(schemaGlobs, {
      cwd: dirname(configPath),
    })
  } catch {
    return { schemaTimeColumn: undefined, candidates: [] }
  }

  const [database, table] = target.split('.')
  if (!database || !table) return { schemaTimeColumn: undefined, candidates: [] }

  const resolved = findTableForTarget(definitions, database, table)
  if (!resolved) return { schemaTimeColumn: undefined, candidates: [] }

  return {
    schemaTimeColumn: extractSchemaTimeColumn(resolved),
    candidates: detectCandidatesFromTable(resolved),
  }
}

export async function detectTimeColumnCandidates(
  target: string,
  schemaGlobs: string | string[],
  configPath: string
): Promise<TimeColumnCandidate[]> {
  let definitions: SchemaDefinition[]
  try {
    definitions = await loadSchemaDefinitions(schemaGlobs, {
      cwd: dirname(configPath),
    })
  } catch {
    return []
  }

  const [database, table] = target.split('.')
  if (!database || !table) return []

  const resolved = findTableForTarget(definitions, database, table)
  if (!resolved) return []

  return detectCandidatesFromTable(resolved)
}
