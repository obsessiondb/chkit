import type {
  ColumnDefinition,
  MaterializedViewDefinition,
  MaterializedViewRefresh,
  ProjectionDefinition,
  SchemaDefinition,
  SkipIndexDefinition,
  TableDefinition,
  ViewDefinition,
} from './model.js'
import { normalizeKeyColumns } from './key-clause.js'
import { isSchemaDefinition } from './model.js'
import { canonicalizeCodec } from './codec.js'
import { normalizeEngine, normalizeSQLFragment } from './sql-normalizer.js'

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name))
}

function sortKind(kind: SchemaDefinition['kind']): number {
  if (kind === 'table') return 0
  if (kind === 'view') return 1
  return 2
}

function canonicalizeColumn(column: ColumnDefinition): ColumnDefinition {
  return {
    ...column,
    name: column.name.trim(),
    renamedFrom: column.renamedFrom?.trim(),
    type: typeof column.type === 'string' ? column.type.trim() : column.type,
    comment: column.comment?.trim(),
    codec: column.codec ? canonicalizeCodec(column.codec) : undefined,
  }
}

function canonicalizeIndex(index: SkipIndexDefinition): SkipIndexDefinition {
  return {
    ...index,
    expression: normalizeSQLFragment(index.expression),
  }
}

function canonicalizeProjection(projection: ProjectionDefinition): ProjectionDefinition {
  return {
    ...projection,
    query: normalizeSQLFragment(projection.query),
  }
}

function canonicalizeTable(def: TableDefinition): TableDefinition {
  const settings = def.settings
    ? Object.fromEntries(
        Object.entries(def.settings).sort(([a], [b]) => a.localeCompare(b))
      )
    : undefined

  const indexes = def.indexes ? sortByName(def.indexes).map(canonicalizeIndex) : undefined
  const projections = def.projections
    ? sortByName(def.projections).map(canonicalizeProjection)
    : undefined

  return {
    ...def,
    database: def.database.trim(),
    name: def.name.trim(),
    renamedFrom: def.renamedFrom
      ? {
          database: def.renamedFrom.database?.trim(),
          name: def.renamedFrom.name.trim(),
        }
      : undefined,
    engine: normalizeEngine(def.engine),
    columns: def.columns.map(canonicalizeColumn),
    primaryKey: normalizeKeyColumns(def.primaryKey),
    orderBy: normalizeKeyColumns(def.orderBy),
    uniqueKey: def.uniqueKey ? normalizeKeyColumns(def.uniqueKey) : undefined,
    partitionBy: def.partitionBy ? normalizeSQLFragment(def.partitionBy) : undefined,
    ttl: def.ttl ? normalizeSQLFragment(def.ttl) : undefined,
    settings,
    indexes,
    projections,
    comment: def.comment?.trim(),
  }
}

function canonicalizeView(def: ViewDefinition): ViewDefinition {
  return {
    ...def,
    database: def.database.trim(),
    name: def.name.trim(),
    as: normalizeSQLFragment(def.as),
    comment: def.comment?.trim(),
  }
}

const INTERVAL_UNIT_PATTERN = /\b(second|minute|hour|day|week|month|year)s?\b/gi

function canonicalizeInterval(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(INTERVAL_UNIT_PATTERN, (unit) => unit.toUpperCase().replace(/S$/, ''))
}

function canonicalizeRefresh(
  refresh: MaterializedViewRefresh | undefined
): MaterializedViewRefresh | undefined {
  if (!refresh) return undefined

  const dependsOn = refresh.dependsOn
    ? [...refresh.dependsOn]
        .map((dep) => ({ database: dep.database.trim(), name: dep.name.trim() }))
        .sort((a, b) => {
          const aKey = `${a.database}.${a.name}`
          const bKey = `${b.database}.${b.name}`
          return aKey.localeCompare(bKey)
        })
    : undefined

  const settings = refresh.settings
    ? Object.fromEntries(
        Object.entries(refresh.settings).sort(([a], [b]) => a.localeCompare(b))
      )
    : undefined

  const canonical: MaterializedViewRefresh = {}
  const every = canonicalizeInterval(refresh.every)
  const after = canonicalizeInterval(refresh.after)
  const offset = canonicalizeInterval(refresh.offset)
  const randomize = canonicalizeInterval(refresh.randomize)
  if (every !== undefined) canonical.every = every
  if (after !== undefined) canonical.after = after
  if (offset !== undefined) canonical.offset = offset
  if (randomize !== undefined) canonical.randomize = randomize
  if (dependsOn && dependsOn.length > 0) canonical.dependsOn = dependsOn
  if (settings && Object.keys(settings).length > 0) canonical.settings = settings
  if (refresh.append) canonical.append = true
  if (refresh.empty) canonical.empty = true
  return canonical
}

function canonicalizeMaterializedView(def: MaterializedViewDefinition): MaterializedViewDefinition {
  const canonical: MaterializedViewDefinition = {
    ...def,
    database: def.database.trim(),
    name: def.name.trim(),
    to: {
      database: def.to.database.trim(),
      name: def.to.name.trim(),
    },
    as: normalizeSQLFragment(def.as),
    comment: def.comment?.trim(),
  }
  const refresh = canonicalizeRefresh(def.refresh)
  if (refresh) {
    canonical.refresh = refresh
  } else {
    delete canonical.refresh
  }
  return canonical
}

export function canonicalizeDefinition(def: SchemaDefinition): SchemaDefinition {
  if (def.kind === 'table') return canonicalizeTable(def)
  if (def.kind === 'view') return canonicalizeView(def)
  return canonicalizeMaterializedView(def)
}

export function definitionKey(def: SchemaDefinition): string {
  return `${def.kind}:${def.database}.${def.name}`
}

export function canonicalizeDefinitions(definitions: SchemaDefinition[]): SchemaDefinition[] {
  const dedup = new Map<string, SchemaDefinition>()
  for (const def of definitions) {
    const normalized = canonicalizeDefinition(def)
    dedup.set(definitionKey(normalized), normalized)
  }

  return [...dedup.values()].sort((a, b) => {
    const kindOrder = sortKind(a.kind) - sortKind(b.kind)
    if (kindOrder !== 0) return kindOrder
    const dbOrder = a.database.localeCompare(b.database)
    if (dbOrder !== 0) return dbOrder
    return a.name.localeCompare(b.name)
  })
}

export function collectDefinitionsFromModule(mod: Record<string, unknown>): SchemaDefinition[] {
  const out: SchemaDefinition[] = []

  const walk = (value: unknown) => {
    if (!value) return
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    if (isSchemaDefinition(value)) {
      out.push(value)
      return
    }
  }

  for (const value of Object.values(mod)) walk(value)
  return canonicalizeDefinitions(out)
}
