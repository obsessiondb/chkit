import { normalizeIndexFromSystemRow } from '@chkit/clickhouse'
import {
  type ColumnDefinition,
  parseCodec,
  type SkipIndexDefinition,
  splitTopLevelComma,
  stripWrappingParens,
  type TableDefinition,
} from '@chkit/core'

import { type Datafile, envSubstitutions } from './datafile.js'
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

const INGESTION_PREFIXES = ['IMPORT_', 'PG_']

/**
 * The columns Tinybird appends to every Kafka datasource (observed on
 * Tinybird Local): after the SCHEMA columns, in this order, with these types,
 * whatever the value or key format. A meta column the SCHEMA declares is
 * dropped from its place and its type replaced. `__headers` is added only
 * when KAFKA_STORE_HEADERS is `true` in any case; `__value` exists even
 * without KAFKA_STORE_RAW_VALUE, which only decides whether it is filled.
 */
const KAFKA_COLUMNS: ColumnDefinition[] = [
  { name: '__value', type: 'String' },
  { name: '__topic', type: 'LowCardinality(String)' },
  { name: '__partition', type: 'Int16' },
  { name: '__offset', type: 'Int64' },
  { name: '__timestamp', type: 'DateTime' },
  { name: '__key', type: 'String' },
]
const KAFKA_HEADERS: ColumnDefinition = { name: '__headers', type: 'Map(String, String)' }
const KAFKA_META = new Set([...KAFKA_COLUMNS, KAFKA_HEADERS].map((column) => column.name))
// `_PATTERN_INDEX_ENTRY` of the Tinybird CLI, matched from the start of the entry as Python's re.match does.
const INDEX_ENTRY = /^(\w+)\s+([\w\s*[\]*(),'"-><.]+)\s+TYPE\s+(\w+)(?:\(([\w\s*.,]+)\))?(?:\s+GRANULARITY\s+(\d+))?/

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

  reasons.push(...envSubstitutions(file))
  if (file.vars.get('ENGINE_SAMPLING_KEY')) {
    reasons.push(`ENGINE_SAMPLING_KEY (SAMPLE BY ${file.vars.get('ENGINE_SAMPLING_KEY')}): the chkit table DSL has no SAMPLE BY`)
  }
  for (const { command, line } of file.unsupported) reasons.push(`${command} (line ${line}) is not evaluated by the importer`)
  if (reasons.length > 0) return { ok: false, reasons }

  const kafka = file.vars.has('KAFKA_CONNECTION_NAME')
  const columns = kafka ? kafkaColumns(tinybirdColumns.map(toColumnDefinition), file.vars.get('KAFKA_STORE_HEADERS')) : tinybirdColumns.map(toColumnDefinition)
  const warnings = kafka ? [kafkaWarning(file.vars.get('KAFKA_TOPIC'))] : []
  const replaced = kafka ? tinybirdColumns.filter((column) => KAFKA_META.has(column.name)).map((column) => column.name) : []
  if (replaced.length > 0) notes.push(`Kafka meta column${replaced.length === 1 ? '' : 's'} ${replaced.join(', ')} declared in SCHEMA ${replaced.length === 1 ? 'is' : 'are'} placed and typed as Tinybird does`)
  const jsonPaths = tinybirdColumns.filter((column) => column.jsonPath).length
  if (jsonPaths > 0) notes.push(`${jsonPaths} JSONPath mapping${jsonPaths === 1 ? '' : 's'} (ingestion only, not part of the DDL)`)
  const ingestion = [...file.vars.keys()].filter((key) => INGESTION_PREFIXES.some((prefix) => key.startsWith(prefix)))
  if (kafka) notes.push(`Kafka columns ${columns.filter((column) => KAFKA_META.has(column.name)).map((column) => column.name).join(', ')} added after the SCHEMA columns, as Tinybird adds them`)
  if (ingestion.length > 0) notes.push(`connector settings not translated (ingestion): ${ingestion.join(', ')}`)
  if (file.blocks.has('FORWARD_QUERY')) notes.push('FORWARD_QUERY not translated (Tinybird deployment migration)')
  if (file.vars.has('SHARED_WITH')) notes.push('SHARED_WITH not translated (Tinybird workspace sharing)')

  const engineParams = engine.params.map((key) => file.vars.get(key)).filter((value): value is string => Boolean(value))
  const engineSql = `${engine.name}(${engineParams.join(', ')})`
  if (engine.keyless) {
    return { ok: true, value: { kind: 'table', database, name: file.name, engine: engineSql, columns, primaryKey: [], orderBy: [] }, notes, ...(warnings.length > 0 ? { warnings } : {}) }
  }

  const partitionBy = file.vars.get('ENGINE_PARTITION_KEY')?.trim() || undefined
  const ttl = file.vars.get('ENGINE_TTL')?.trim() || undefined
  const settings = parseSettings(file.vars.get('ENGINE_SETTINGS'))
  const verdict = ttlPartitionVerdict({
    partitionKey: partitionBy,
    ttl,
    // The columns ClickHouse gets, Kafka meta columns included (a TTL on __timestamp counts).
    columnTypes: new Map(columns.map((column) => [column.name, column.nullable ? `Nullable(${column.type})` : String(column.type)])),
  })
  if (verdict === 'compatible' && !('ttl_only_drop_parts' in settings)) {
    settings.ttl_only_drop_parts = 1
    notes.push('ttl_only_drop_parts = 1 added, as Tinybird does when the TTL matches the partition period')
  }
  let indexes: SkipIndexDefinition[]
  try {
    const parsed = parseIndexes(file.blocks.get('INDEXES'), database, file.name)
    for (const { written, name } of parsed) {
      if (written !== name) notes.push(`index ${written} is created as ${name}, as Tinybird strips leading I, N, D, E and X from index entries`)
    }
    indexes = parsed.map(({ written: _written, ...index }) => index)
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
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/** SCHEMA columns without Kafka meta columns, then Tinybird's Kafka columns. */
function kafkaColumns(columns: ColumnDefinition[], storeHeaders: string | undefined): ColumnDefinition[] {
  const headers = storeHeaders?.trim().toLowerCase() === 'true'
  return [...columns.filter((column) => !KAFKA_META.has(column.name)), ...KAFKA_COLUMNS, ...(headers ? [KAFKA_HEADERS] : [])]
}

function kafkaWarning(topic: string | undefined): string {
  return `Kafka ingestion is not translated: the table keeps Tinybird's Kafka columns, and something must consume topic ${topic ?? '(unset)'} into it. ObsessionDB has no Kafka CDC yet; a ClickHouse Kafka engine table with a materialized view, @chkit/plugin-ingest or your own inserts can fill it.`
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
    // A number beyond 2^53 keeps its digits as SQL text.
    if (key) settings[key] = /^-?\d+(?:\.\d+)?$/.test(raw) && (raw.includes('.') || Number.isSafeInteger(Number(raw))) ? Number(raw) : raw
  }
  return settings
}

/**
 * INDEXES as the Tinybird CLI reads them (`parse_indexes_structure`): each
 * entry is stripped, its trailing comma dropped, then `lstrip("INDEX")`, which
 * removes every leading I, N, D, E or X, so an index named `EXP_idx` is created
 * as `P_idx`. The names returned are the ones ClickHouse gets.
 */
function parseIndexes(block: string | undefined, database: string, table: string): Array<SkipIndexDefinition & { written: string }> {
  if (!block) return []
  return block
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const entry = line.trim().replace(/,+$/, '').replace(/^[INDEX]+/, '').trim()
      const match = entry.split('TYPE').length === 2 ? INDEX_ENTRY.exec(entry) : null
      if (!match) throw new Error(`INDEXES: cannot read "${line.trim()}" (expected name expr TYPE type [GRANULARITY n])`)
      const written = (/^\s*(?:INDEX\s+)?(\w+)/.exec(line)?.[1] ?? '')
      const index = normalizeIndexFromSystemRow({
        database,
        table,
        name: match[1] ?? '',
        expr: (match[2] ?? '').trim(),
        type: match[4] !== undefined ? `${match[3]}(${match[4]})` : (match[3] ?? ''),
        granularity: Number(match[5] ?? 1),
      })
      return { ...index, written }
    })
}
