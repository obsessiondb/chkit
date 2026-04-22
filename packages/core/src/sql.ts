import type {
  ColumnDefinition,
  MaterializedViewDefinition,
  MaterializedViewRefresh,
  SchemaDefinition,
  SkipIndexDefinition,
  TableDefinition,
  ViewDefinition,
} from './model.js'
import { renderCodec } from './codec.js'
import { normalizeKeyColumns } from './key-clause.js'
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
  if (col.codec) out += ` ${renderCodec(col.codec)}`
  if (col.default !== undefined) out += ` DEFAULT ${renderDefault(col.default)}`
  if (col.comment) out += ` COMMENT '${col.comment.replace(/'/g, "''")}'`
  return out
}

function renderKeyClauseColumns(columns: string[]): string {
  return normalizeKeyColumns(columns)
    .map((column) => `\`${column}\``)
    .join(', ')
}

function renderIndexType(idx: SkipIndexDefinition): string {
  return idx.typeArgs !== undefined ? `${idx.type}(${idx.typeArgs})` : idx.type
}

function renderTableSQL(def: TableDefinition): string {
  const columns = def.columns.map(renderColumn)
  const indexes = (def.indexes ?? []).map(
    (idx) =>
      `INDEX \`${idx.name}\` (${idx.expression}) TYPE ${renderIndexType(idx)} GRANULARITY ${idx.granularity}`
  )
  const projections = (def.projections ?? []).map(
    (projection) => `PROJECTION \`${projection.name}\` (${projection.query})`
  )
  const body = [...columns, ...indexes, ...projections].join(',\n  ')

  const clauses: string[] = []
  if (def.partitionBy) clauses.push(`PARTITION BY ${def.partitionBy}`)
  clauses.push(`PRIMARY KEY (${renderKeyClauseColumns(def.primaryKey)})`)
  clauses.push(`ORDER BY (${renderKeyClauseColumns(def.orderBy)})`)
  if (def.uniqueKey && def.uniqueKey.length > 0) {
    clauses.push(`UNIQUE KEY (${renderKeyClauseColumns(def.uniqueKey)})`)
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
export function renderRefreshClause(refresh: MaterializedViewRefresh): string {
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

export function toCreateSQL(def: SchemaDefinition): string {
  assertValidDefinitions([def])
  if (def.kind === 'table') return renderTableSQL(def)
  if (def.kind === 'view') return renderViewSQL(def)
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

export function renderAlterAddProjection(def: TableDefinition, projection: { name: string; query: string }): string {
  return `ALTER TABLE ${def.database}.${def.name} ADD PROJECTION IF NOT EXISTS \`${projection.name}\` (${projection.query});`
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
