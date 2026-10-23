import type {
  ColumnDefinition,
  DictionaryAttribute,
  DictionaryDefinition,
  MaterializedViewDefinition,
  MaterializedViewRefresh,
  ProjectionDefinition,
  SchemaDefinition,
  SkipIndexDefinition,
  TableConstraintDefinition,
  TableDefinition,
  ViewDefinition,
} from './model.js'
import { renderCodec } from './codec.js'
import { renderDefault } from './column-default.js'
import { constraintExpression, constraintKind, renderConstraint } from './constraint.js'
import { quoteIdentifier, renderQualifiedName } from './identifier.js'
import { isMergeTreeEngine, supportsSortOrder } from './engine.js'
import { isKafkaEngine, renderKafkaSetting } from './kafka.js'
import { isPlainColumnReference, normalizeKeyColumns } from './key-clause.js'
import { renderProjectionBody } from './projection.js'
import { normalizeSQLFragment } from './sql-normalizer.js'
import { TEXT_INDEX_GRANULARITY, renderTextIndexType } from './text-index.js'
import { assertValidDefinitions } from './validate.js'
import { renderVectorIndexType, vectorIndexGranularity } from './vector-index.js'

function renderColumn(col: ColumnDefinition): string {
  let out = `${quoteIdentifier(col.name)} ${renderColumnType(col)}`
  if (col.default !== undefined) out += ` ${col.defaultKind ?? 'DEFAULT'} ${renderDefault(col.default)}`
  else if (col.defaultKind === 'EPHEMERAL') out += ' EPHEMERAL'
  if (col.comment) out += ` COMMENT '${col.comment.replace(/'/g, "''")}'`
  if (col.codec) out += ` ${renderCodec(col.codec)}`
  return out
}

export function renderColumnType(column: Pick<ColumnDefinition, 'type' | 'nullable'>): string {
  const type = String(column.type).trim()
  return column.nullable ? `Nullable(${type})` : type
}

export function renderKeyClauseColumns(
  columns: string[],
  columnNames: ReadonlySet<string>
): string {
  return normalizeKeyColumns(columns, columnNames)
    .map((column) =>
      // Quote a token when it names a declared column (including names that
      // need quoting like `user-id`) or is a bare identifier. Only true
      // expressions (e.g. `toStartOfHour(ts)`) are emitted verbatim.
      columnNames.has(column) || isPlainColumnReference(column) ? quoteIdentifier(column) : column
    )
    .join(', ')
}

export function renderIndexType(idx: SkipIndexDefinition): string {
  switch (idx.type) {
    case 'text':
      return renderTextIndexType(idx)
    case 'vector_similarity':
      return renderVectorIndexType(idx)
    case 'raw':
      return normalizeSQLFragment(idx.rawType)
    case 'minmax':
      return 'minmax'
    case 'set':
      return `set(${idx.maxRows})`
    case 'bloom_filter':
      return idx.falsePositiveRate !== undefined
        ? `bloom_filter(${idx.falsePositiveRate})`
        : 'bloom_filter'
    case 'tokenbf_v1':
      return `tokenbf_v1(${idx.sizeBytes}, ${idx.hashFunctions}, ${idx.randomSeed})`
    case 'ngrambf_v1':
      return `ngrambf_v1(${idx.ngramSize}, ${idx.sizeBytes}, ${idx.hashFunctions}, ${idx.randomSeed})`
  }
}

function renderIndexGranularity(idx: SkipIndexDefinition): number {
  if (idx.type === 'text') return TEXT_INDEX_GRANULARITY
  if (idx.type === 'vector_similarity') return vectorIndexGranularity(idx)
  return idx.granularity
}

function renderTableSQL(def: TableDefinition): string {
  const columns = def.columns.map(renderColumn)
  const indexes = (def.indexes ?? []).map(
    (idx) =>
      `INDEX ${quoteIdentifier(idx.name)} (${idx.expression}) TYPE ${renderIndexType(idx)} GRANULARITY ${renderIndexGranularity(idx)}`
  )
  const constraints = (def.constraints ?? []).map(renderConstraint)
  const projections = (def.projections ?? []).map(
    (projection) => `PROJECTION ${quoteIdentifier(projection.name)} ${renderProjectionBody(projection)}`
  )
  const body = [...columns, ...indexes, ...constraints, ...projections].join(',\n  ')

  const columnNames = new Set(def.columns.map((column) => column.name))
  const clauses: string[] = []
  // Only engines that support sort order take key clauses; ClickHouse rejects
  // them on Distributed, Memory, Null, Kafka and the like. MergeTree always
  // gets PRIMARY KEY/ORDER BY (an empty key is `()`), other engines only the
  // keys they set.
  if (supportsSortOrder(def.engine)) {
    const mergeTree = isMergeTreeEngine(def.engine)
    if (def.partitionBy) clauses.push(`PARTITION BY ${def.partitionBy}`)
    if (mergeTree || def.primaryKey.length > 0) {
      clauses.push(`PRIMARY KEY (${renderKeyClauseColumns(def.primaryKey, columnNames)})`)
    }
    if (mergeTree || def.orderBy.length > 0) {
      clauses.push(`ORDER BY (${renderKeyClauseColumns(def.orderBy, columnNames)})`)
    }
  }
  if (def.uniqueKey && def.uniqueKey.length > 0) {
    clauses.push(`UNIQUE KEY (${renderKeyClauseColumns(def.uniqueKey, columnNames)})`)
  }
  if (def.ttl) clauses.push(`TTL ${def.ttl}`)
  if (def.settings && Object.keys(def.settings).length > 0) {
    clauses.push(
      `SETTINGS ${Object.entries(def.settings)
        .map(([k, v]) => `${k} = ${isKafkaEngine(def.engine) ? renderKafkaSetting(v) : v}`)
        .join(', ')}`
    )
  }
  if (def.comment) clauses.push(`COMMENT '${def.comment.replace(/'/g, "''")}'`)

  return `CREATE TABLE IF NOT EXISTS ${renderQualifiedName(def.database, def.name)}\n(\n  ${body}\n) ENGINE = ${def.engine}\n${clauses.join('\n')};`
}

function renderViewSQL(def: ViewDefinition): string {
  return `CREATE VIEW IF NOT EXISTS ${renderQualifiedName(def.database, def.name)} AS\n${def.as};`
}

function renderRefreshSettings(settings: Record<string, string | number>): string {
  return Object.entries(settings)
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v}`)
    .join(', ')
}

function renderDependsOn(dependsOn: Array<{ database: string; name: string }>): string {
  return dependsOn.map((dep) => renderQualifiedName(dep.database, dep.name)).join(', ')
}

/**
 * Renders the REFRESH clause block for a refreshable materialized view.
 * Grammar order: REFRESH EVERY|AFTER <interval> [OFFSET <interval>] [RANDOMIZE FOR <interval>]
 *                [DEPENDS ON <list>] [SETTINGS <kv>] [APPEND]
 * Note: EMPTY belongs after TO in CREATE, so it's NOT included here.
 */
function renderRefreshClause(refresh: MaterializedViewRefresh): string {
  const parts: string[] = []
  if (refresh.every) parts.push(`REFRESH EVERY ${refresh.every}`)
  else if (refresh.after) parts.push(`REFRESH AFTER ${refresh.after}`)
  if (refresh.offset) parts.push(`OFFSET ${refresh.offset}`)
  if (refresh.randomize) parts.push(`RANDOMIZE FOR ${refresh.randomize}`)
  if (refresh.dependsOn && refresh.dependsOn.length > 0) {
    parts.push(`DEPENDS ON ${renderDependsOn(refresh.dependsOn)}`)
  }
  if (refresh.settings && Object.keys(refresh.settings).length > 0) {
    parts.push(`SETTINGS ${renderRefreshSettings(refresh.settings)}`)
  }
  if (refresh.append) parts.push('APPEND')
  return parts.join(' ')
}

function renderMaterializedViewSQL(def: MaterializedViewDefinition): string {
  const header = `CREATE MATERIALIZED VIEW IF NOT EXISTS ${renderQualifiedName(def.database, def.name)}`
  const refreshBlock = def.refresh ? `\n${renderRefreshClause(def.refresh)}` : ''
  const toClause = ` TO ${renderQualifiedName(def.to.database, def.to.name)}`
  const emptyClause = def.refresh?.empty ? ' EMPTY' : ''
  return `${header}${refreshBlock}${toClause}${emptyClause} AS\n${def.as};`
}

/**
 * Renders ALTER TABLE ... MODIFY REFRESH for a refresh-only change.
 * Per live validation: APPEND must be re-included if present, because ClickHouse
 * treats omitting APPEND as "remove APPEND" and rejects.
 */
export function renderAlterModifyRefresh(def: MaterializedViewDefinition): string {
  if (!def.refresh) {
    throw new Error(
      `Cannot render MODIFY REFRESH for ${def.database}.${def.name}: refresh is not set`
    )
  }
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} MODIFY ${renderRefreshClause(def.refresh)};`
}

function renderDictionaryAttribute(attr: DictionaryAttribute): string {
  let out = `${quoteIdentifier(attr.name)} ${attr.type}`
  if (attr.expression !== undefined) out += ` EXPRESSION ${attr.expression}`
  else if (attr.default !== undefined) out += ` DEFAULT ${renderDefault(attr.default)}`
  if (attr.hierarchical) out += ' HIERARCHICAL'
  if (attr.bidirectional) out += ' BIDIRECTIONAL'
  if (attr.injective) out += ' INJECTIVE'
  if (attr.isObjectId) out += ' IS_OBJECT_ID'
  return out
}

function renderDictionaryRangeColumn(column: string, columnNames: ReadonlySet<string>): string {
  return columnNames.has(column) || isPlainColumnReference(column) ? quoteIdentifier(column) : column
}

function renderDictionarySettings(settings: Record<string, string | number>): string {
  return Object.entries(settings)
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v}`)
    .join(', ')
}

export function renderDictionarySQL(def: DictionaryDefinition, replace = false): string {
  const verb = replace ? 'CREATE OR REPLACE DICTIONARY' : 'CREATE DICTIONARY IF NOT EXISTS'
  const attrs = def.attributes.map(renderDictionaryAttribute).join(',\n  ')
  const columnNames = new Set(def.attributes.map((a) => a.name))
  const pk = renderKeyClauseColumns(def.primaryKey, columnNames)
  const clauses = [
    `PRIMARY KEY ${pk}`,
    `SOURCE(${def.source})`,
    `LAYOUT(${def.layout})`,
    `LIFETIME(${def.lifetime})`,
  ]
  if (def.range) {
    clauses.push(
      `RANGE(MIN ${renderDictionaryRangeColumn(def.range.min, columnNames)} MAX ${renderDictionaryRangeColumn(def.range.max, columnNames)})`
    )
  }
  if (def.settings && Object.keys(def.settings).length > 0) {
    clauses.push(`SETTINGS(${renderDictionarySettings(def.settings)})`)
  }
  if (def.comment) clauses.push(`COMMENT '${def.comment.replace(/'/g, "''")}'`)
  return `${verb} ${renderQualifiedName(def.database, def.name)}\n(\n  ${attrs}\n)\n${clauses.join('\n')};`
}

export function toCreateSQL(def: SchemaDefinition): string {
  assertValidDefinitions([def])
  if (def.kind === 'table') return renderTableSQL(def)
  if (def.kind === 'view') return renderViewSQL(def)
  if (def.kind === 'dictionary') return renderDictionarySQL(def)
  return renderMaterializedViewSQL(def)
}

export function renderAlterAddColumn(def: TableDefinition, column: ColumnDefinition): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} ADD COLUMN IF NOT EXISTS ${renderColumn(column)};`
}

export function renderAlterModifyColumn(def: TableDefinition, column: ColumnDefinition): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} MODIFY COLUMN ${renderColumn(column)};`
}

/**
 * MODIFY COLUMN without an expression keeps the old one, so dropping it needs an
 * explicit REMOVE. It must run before the MODIFY: in one statement ClickHouse
 * casts the retained default to the new type first, so `'abc'` -> UInt64 fails.
 */
export function renderAlterRemoveColumnExpression(
  def: TableDefinition,
  column: ColumnDefinition,
  previous: ColumnDefinition
): string | undefined {
  if (previous.default === undefined || column.default !== undefined || column.defaultKind === 'EPHEMERAL') return undefined
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} MODIFY COLUMN ${quoteIdentifier(column.name)} REMOVE ${previous.defaultKind ?? 'DEFAULT'};`
}

export function renderAlterDropColumn(def: TableDefinition, columnName: string): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} DROP COLUMN IF EXISTS ${quoteIdentifier(columnName)};`
}

export function renderAlterRemoveCodec(def: TableDefinition, columnName: string): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} MODIFY COLUMN ${quoteIdentifier(columnName)} REMOVE CODEC;`
}

export function renderAlterAddIndex(def: TableDefinition, index: SkipIndexDefinition): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} ADD INDEX IF NOT EXISTS ${quoteIdentifier(index.name)} (${index.expression}) TYPE ${renderIndexType(index)} GRANULARITY ${renderIndexGranularity(index)};`
}

export function renderAlterDropIndex(def: TableDefinition, indexName: string): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} DROP INDEX IF EXISTS ${quoteIdentifier(indexName)};`
}

export function renderAlterAddConstraint(def: TableDefinition, constraint: TableConstraintDefinition): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} ADD CONSTRAINT IF NOT EXISTS ${quoteIdentifier(constraint.name)} ${constraintKind(constraint)} ${constraintExpression(constraint)};`
}

export function renderAlterDropConstraint(def: TableDefinition, constraintName: string): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(constraintName)};`
}

export function renderAlterAddProjection(
  def: TableDefinition,
  projection: ProjectionDefinition
): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} ADD PROJECTION IF NOT EXISTS ${quoteIdentifier(projection.name)} ${renderProjectionBody(projection)};`
}

export function renderAlterDropProjection(def: TableDefinition, projectionName: string): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} DROP PROJECTION IF EXISTS ${quoteIdentifier(projectionName)};`
}

export function renderAlterModifySetting(
  def: TableDefinition,
  key: string,
  value: string | number | boolean
): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} MODIFY SETTING ${key} = ${value};`
}

export function renderAlterResetSetting(def: TableDefinition, key: string): string {
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} RESET SETTING ${key};`
}

export function renderAlterModifyTTL(def: TableDefinition, ttl: string | undefined): string {
  if (ttl === undefined) {
    return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} REMOVE TTL;`
  }
  return `ALTER TABLE ${renderQualifiedName(def.database, def.name)} MODIFY TTL ${ttl};`
}
