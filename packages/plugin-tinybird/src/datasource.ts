import { normalizeIndexFromSystemRow } from '@chkit/clickhouse'
import {
  type ColumnDefinition,
  parseCodec,
  type SkipIndexDefinition,
  splitTopLevelComma,
  stripWrappingParens,
  type TableDefinition,
} from '@chkit/core'

import type { Datafile } from './datafile.js'
import type { Translation } from './report.js'
import { parseSchemaColumns, type TinybirdColumn } from './schema-columns.js'
import { ttlPartitionVerdict } from './ttl-partition.js'

/**
 * The engines Tinybird accepts and their positional parameters
 * (`ENABLED_ENGINES` in `tinybird/ch_utils/engine.py`), in the order Tinybird
 * writes them: `ReplacingMergeTree(ver, is_deleted)`.
 */
const ENGINES: Record<string, { name: string; params: string[]; keyless?: boolean }> = {
  mergetree: { name: 'MergeTree', params: [] },
  replacingmergetree: { name: 'ReplacingMergeTree', params: ['ENGINE_VER', 'ENGINE_IS_DELETED'] },
  summingmergetree: { name: 'SummingMergeTree', params: ['ENGINE_COLUMNS'] },
  aggregatingmergetree: { name: 'AggregatingMergeTree', params: [] },
  collapsingmergetree: { name: 'CollapsingMergeTree', params: ['ENGINE_SIGN'] },
  versionedcollapsingmergetree: { name: 'VersionedCollapsingMergeTree', params: ['ENGINE_SIGN', 'ENGINE_VERSION'] },
  null: { name: 'Null', params: [], keyless: true },
}

const INGESTION_PREFIXES = ['KAFKA_', 'IMPORT_', 'PG_']
const INDEX_LINE = /^\s*(?:INDEX\s+)?(\S+)\s+(.+?)\s+TYPE\s+(.+?)(?:\s+GRANULARITY\s+(\d+))?\s*,?\s*$/
const ENV_SUBSTITUTION = /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/

export function translateDatasource(file: Datafile, database: string): Translation<TableDefinition> {
  const reasons: string[] = []
  const notes: string[] = []
  const schema = file.blocks.get('SCHEMA')
  if (!schema) return { ok: false, reasons: ['the datasource has no SCHEMA'] }

  let tinybirdColumns: TinybirdColumn[]
  try {
    tinybirdColumns = parseSchemaColumns(schema)
  } catch (error) {
    return { ok: false, reasons: [`SCHEMA: ${error instanceof Error ? error.message : String(error)}`] }
  }

  const engineName = file.vars.get('ENGINE') ?? 'MergeTree'
  const engine = ENGINES[engineName.toLowerCase()]
  if (!engine) return { ok: false, reasons: [`engine ${engineName} is not one Tinybird supports`] }

  for (const [key, value] of file.vars) {
    if (key.startsWith('ENGINE') && ENV_SUBSTITUTION.test(value)) {
      reasons.push(`${key} uses environment substitution (${ENV_SUBSTITUTION.exec(value)?.[0]}), which the importer does not evaluate`)
    }
  }
  if (file.vars.get('ENGINE_SAMPLING_KEY')) {
    reasons.push(`ENGINE_SAMPLING_KEY (SAMPLE BY ${file.vars.get('ENGINE_SAMPLING_KEY')}): the chkit table DSL has no SAMPLE BY`)
  }
  for (const { command, line } of file.unsupported) reasons.push(`${command} (line ${line}) is not evaluated by the importer`)
  if (reasons.length > 0) return { ok: false, reasons }

  const columns = tinybirdColumns.map(toColumnDefinition)
  const jsonPaths = tinybirdColumns.filter((column) => column.jsonPath).length
  if (jsonPaths > 0) notes.push(`${jsonPaths} JSONPath mapping${jsonPaths === 1 ? '' : 's'} (ingestion only, not part of the DDL)`)
  const ingestion = [...file.vars.keys()].filter((key) => INGESTION_PREFIXES.some((prefix) => key.startsWith(prefix)))
  if (ingestion.length > 0) notes.push(`connector settings not translated (ingestion): ${ingestion.join(', ')}`)
  if (file.blocks.has('FORWARD_QUERY')) notes.push('FORWARD_QUERY not translated (Tinybird deployment migration)')
  if (file.vars.has('SHARED_WITH')) notes.push('SHARED_WITH not translated (Tinybird workspace sharing)')

  const engineParams = engine.params.map((key) => file.vars.get(key)).filter((value): value is string => Boolean(value))
  const engineSql = `${engine.name}(${engineParams.join(', ')})`
  if (engine.keyless) {
    return { ok: true, value: { kind: 'table', database, name: file.name, engine: engineSql, columns, primaryKey: [], orderBy: [] }, notes }
  }

  const partitionBy = file.vars.get('ENGINE_PARTITION_KEY')?.trim() || undefined
  const ttl = file.vars.get('ENGINE_TTL')?.trim() || undefined
  const settings = parseSettings(file.vars.get('ENGINE_SETTINGS'))
  const verdict = ttlPartitionVerdict({
    partitionKey: partitionBy,
    ttl,
    columnTypes: new Map(tinybirdColumns.map((column) => [column.name, column.type])),
  })
  if (verdict === 'compatible' && !('ttl_only_drop_parts' in settings)) {
    settings.ttl_only_drop_parts = 1
    notes.push('ttl_only_drop_parts = 1 added, as Tinybird does when the TTL matches the partition period')
  }
  let indexes: SkipIndexDefinition[]
  try {
    indexes = parseIndexes(file.blocks.get('INDEXES'), database, file.name)
  } catch (error) {
    return { ok: false, reasons: [error instanceof Error ? error.message : String(error)] }
  }

  return {
    ok: true,
    value: {
      kind: 'table',
      database,
      name: file.name,
      engine: engineSql,
      columns,
      orderBy: keyColumns(file.vars.get('ENGINE_SORTING_KEY')),
      primaryKey: keyColumns(file.vars.get('ENGINE_PRIMARY_KEY')),
      ...(partitionBy ? { partitionBy } : {}),
      ...(ttl ? { ttl } : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(indexes.length > 0 ? { indexes } : {}),
    },
    notes,
  }
}

function toColumnDefinition(column: TinybirdColumn): ColumnDefinition {
  const nullable = /^Nullable\((.+)\)$/.exec(column.type)?.[1]
  const codec = parseCodec(column.codec ? `CODEC(${column.codec})` : undefined)
  return {
    name: column.name,
    type: nullable ?? column.type,
    ...(nullable ? { nullable: true } : {}),
    ...(column.default !== undefined ? { default: { expression: column.default } } : {}),
    ...(codec ? { codec } : {}),
  }
}

/** A sorting or primary key; `tuple()` and an empty key are no key columns. */
function keyColumns(value: string | undefined): string[] {
  const key = stripWrappingParens(value?.trim() ?? '')
  if (!key || key.replace(/\s+/g, '') === 'tuple()') return []
  return splitTopLevelComma(key).map((part) => part.trim()).filter((part) => part.length > 0)
}

/** `ENGINE_SETTINGS "a = 1, b = 'x'"`: numbers as numbers, anything else as the SQL text Tinybird sends. */
function parseSettings(value: string | undefined): Record<string, string | number> {
  const settings: Record<string, string | number> = {}
  for (const item of splitTopLevelComma(value ?? '')) {
    const eq = item.indexOf('=')
    if (eq < 0) continue
    const key = item.slice(0, eq).trim()
    const raw = item.slice(eq + 1).trim()
    if (key) settings[key] = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw
  }
  return settings
}

function parseIndexes(block: string | undefined, database: string, table: string): SkipIndexDefinition[] {
  if (!block) return []
  return block
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = INDEX_LINE.exec(line)
      if (!match) throw new Error(`INDEXES: cannot read "${line.trim()}" (expected name expr TYPE type [GRANULARITY n])`)
      return normalizeIndexFromSystemRow({
        database,
        table,
        name: match[1] ?? '',
        expr: match[2] ?? '',
        type: match[3] ?? '',
        granularity: Number(match[4] ?? 1),
      })
    })
}
