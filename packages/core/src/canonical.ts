import type {
  ColumnDefinition,
  MaterializedViewDefinition,
  ProjectionDefinition,
  SchemaDefinition,
  SkipIndexDefinition,
  TableDefinition,
  ViewDefinition,
} from './model.js'
import { isSchemaDefinition } from './model.js'

function normalizeSQLFragment(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

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
    engine: def.engine.trim(),
    columns: def.columns.map(canonicalizeColumn),
    primaryKey: [...def.primaryKey].map((k) => k.trim()),
    orderBy: [...def.orderBy].map((k) => k.trim()),
    uniqueKey: def.uniqueKey?.map((k) => k.trim()),
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

function canonicalizeMaterializedView(def: MaterializedViewDefinition): MaterializedViewDefinition {
  return {
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
