import type {
  ColumnDefinition,
  DictionaryAttribute,
  DictionaryDefinition,
  MaterializedViewDefinition,
  MaterializedViewRefresh,
  ProjectionDefinition,
  SchemaDefinition,
  SkipIndexDefinition,
  TableDefinition,
  ViewDefinition,
} from './model.js'
import { renderCodec } from './codec.js'
import { isPlainColumnReference, normalizeKeyColumns } from './key-clause.js'
import { renderProjectionBody } from './projection.js'
import { assertValidDefinitions } from './validate.js'

function renderDefault(value: string | number | boolean): string {
  if (typeof value === 'string') {
    if (value.startsWith('fn:')) return value.slice(3)
    return `'${value.replace(/'/g, "''")}'`
  }
  return String(value)
}

function renderColumn(col: ColumnDefinition): string {
  let out = `\`${col.name}\` ${col.nullable ? `Nullable(${col.type})` : col.type}`
  if (col.default !== undefined) out += ` DEFAULT ${renderDefault(col.default)}`
  if (col.comment) out += ` COMMENT '${col.comment.replace(/'/g, "''")}'`
  if (col.codec) out += ` ${renderCodec(col.codec)}`
  return out
}

function renderKeyClauseColumns(columns: string[], columnNames: Set<string>): string {
  return normalizeKeyColumns(columns)
    .map((column) =>
      // Quote a token when it names a declared column (including names that
      // need quoting like `user-id`) or is a bare identifier. Only true
      // expressions (e.g. `toStartOfHour(ts)`) are emitted verbatim.
      columnNames.has(column) || isPlainColumnReference(column) ? `\`${column}\`` : column
    )
    .join(', ')
}

function renderIndexType(idx: SkipIndexDefinition): string {
  switch (idx.type) {
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

function renderTableSQL(def: TableDefinition): string {
  const columns = def.columns.map(renderColumn)
  const indexes = (def.indexes ?? []).map(
    (idx) =>
      `INDEX \`${idx.name}\` (${idx.expression}) TYPE ${renderIndexType(idx)} GRANULARITY ${idx.granularity}`
  )
  const projections = (def.projections ?? []).map(
    (projection) => `PROJECTION \`${projection.name}\` ${renderProjectionBody(projection)}`
  )
  const body = [...columns, ...indexes, ...projections].join(',\n  ')

  const columnNames = new Set(def.columns.map((column) => column.name))
  const clauses: string[] = []
  if (def.partitionBy) clauses.push(`PARTITION BY ${def.partitionBy}`)
  clauses.push(`PRIMARY KEY (${renderKeyClauseColumns(def.primaryKey, columnNames)})`)
  clauses.push(`ORDER BY (${renderKeyClauseColumns(def.orderBy, columnNames)})`)
  if (def.uniqueKey && def.uniqueKey.length > 0) {
    clauses.push(`UNIQUE KEY (${renderKeyClauseColumns(def.uniqueKey, columnNames)})`)
  }
  if (def.ttl) clauses.push(`TTL ${def.ttl}`)
  if (def.settings && Object.keys(def.settings).length > 0) {
    clauses.push(
      `SETTINGS ${Object.entries(def.settings)
        .map(([k, v]) => `${k} = ${v}`)
        .join(', ')}`
    )
  }
  if (def.comment) clauses.push(`COMMENT '${def.comment.replace(/'/g, "''")}'`)

  return `CREATE TABLE IF NOT EXISTS ${def.database}.${def.name}\n(\n  ${body}\n) ENGINE = ${def.engine}\n${clauses.join('\n')};`
}

function renderViewSQL(def: ViewDefinition): string {
  return `CREATE VIEW IF NOT EXISTS ${def.database}.${def.name} AS\n${def.as};`
}

function renderRefreshSettings(settings: Record<string, string | number>): string {
  return Object.entries(settings)
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v}`)
    .join(', ')
}

function renderDependsOn(dependsOn: Array<{ database: string; name: string }>): string {
  return dependsOn.map((dep) => `${dep.database}.${dep.name}`).join(', ')
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
  const header = `CREATE MATERIALIZED VIEW IF NOT EXISTS ${def.database}.${def.name}`
  const refreshBlock = def.refresh ? `\n${renderRefreshClause(def.refresh)}` : ''
  const toClause = ` TO ${def.to.database}.${def.to.name}`
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
  return `ALTER TABLE ${def.database}.${def.name} MODIFY ${renderRefreshClause(def.refresh)};`
}

function renderDictionaryAttribute(attr: DictionaryAttribute): string {
  let out = `\`${attr.name}\` ${attr.type}`
  if (attr.expression !== undefined) out += ` EXPRESSION ${attr.expression}`
  else if (attr.default !== undefined) out += ` DEFAULT ${renderDefault(attr.default)}`
  if (attr.hierarchical) out += ' HIERARCHICAL'
  if (attr.bidirectional) out += ' BIDIRECTIONAL'
  if (attr.injective) out += ' INJECTIVE'
  if (attr.isObjectId) out += ' IS_OBJECT_ID'
  return out
}

function renderDictionaryRangeColumn(column: string, columnNames: Set<string>): string {
  return columnNames.has(column) || isPlainColumnReference(column) ? `\`${column}\`` : column
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
  return `${verb} ${def.database}.${def.name}\n(\n  ${attrs}\n)\n${clauses.join('\n')};`
}

export function toCreateSQL(def: SchemaDefinition): string {
  assertValidDefinitions([def])
  if (def.kind === 'table') return renderTableSQL(def)
  if (def.kind === 'view') return renderViewSQL(def)
  if (def.kind === 'dictionary') return renderDictionarySQL(def)
  return renderMaterializedViewSQL(def)
}

export function renderAlterAddColumn(def: TableDefinition, column: ColumnDefinition): string {
  return `ALTER TABLE ${def.database}.${def.name} ADD COLUMN IF NOT EXISTS ${renderColumn(column)};`
}

export function renderAlterModifyColumn(def: TableDefinition, column: ColumnDefinition): string {
  return `ALTER TABLE ${def.database}.${def.name} MODIFY COLUMN ${renderColumn(column)};`
}

export function renderAlterDropColumn(def: TableDefinition, columnName: string): string {
  return `ALTER TABLE ${def.database}.${def.name} DROP COLUMN IF EXISTS \`${columnName}\`;`
}

export function renderAlterRemoveCodec(def: TableDefinition, columnName: string): string {
  return `ALTER TABLE ${def.database}.${def.name} MODIFY COLUMN \`${columnName}\` REMOVE CODEC;`
}

export function renderAlterAddIndex(def: TableDefinition, index: SkipIndexDefinition): string {
  return `ALTER TABLE ${def.database}.${def.name} ADD INDEX IF NOT EXISTS \`${index.name}\` (${index.expression}) TYPE ${renderIndexType(index)} GRANULARITY ${index.granularity};`
}

export function renderAlterDropIndex(def: TableDefinition, indexName: string): string {
  return `ALTER TABLE ${def.database}.${def.name} DROP INDEX IF EXISTS \`${indexName}\`;`
}

export function renderAlterAddProjection(
  def: TableDefinition,
  projection: ProjectionDefinition
): string {
  return `ALTER TABLE ${def.database}.${def.name} ADD PROJECTION IF NOT EXISTS \`${projection.name}\` ${renderProjectionBody(projection)};`
}

export function renderAlterDropProjection(def: TableDefinition, projectionName: string): string {
  return `ALTER TABLE ${def.database}.${def.name} DROP PROJECTION IF EXISTS \`${projectionName}\`;`
}

export function renderAlterModifySetting(
  def: TableDefinition,
  key: string,
  value: string | number | boolean
): string {
  return `ALTER TABLE ${def.database}.${def.name} MODIFY SETTING ${key} = ${value};`
}

export function renderAlterResetSetting(def: TableDefinition, key: string): string {
  return `ALTER TABLE ${def.database}.${def.name} RESET SETTING ${key};`
}

export function renderAlterModifyTTL(def: TableDefinition, ttl: string | undefined): string {
  if (ttl === undefined) {
    return `ALTER TABLE ${def.database}.${def.name} REMOVE TTL;`
  }
  return `ALTER TABLE ${def.database}.${def.name} MODIFY TTL ${ttl};`
}
