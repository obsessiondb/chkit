export type PrimitiveColumnType =
  | 'String'
  | 'UInt8'
  | 'UInt16'
  | 'UInt32'
  | 'UInt64'
  | 'UInt128'
  | 'UInt256'
  | 'Int8'
  | 'Int16'
  | 'Int32'
  | 'Int64'
  | 'Int128'
  | 'Int256'
  | 'Float32'
  | 'Float64'
  | 'Bool'
  | 'Boolean'
  | 'Date'
  | 'DateTime'
  | 'DateTime64'

export interface ColumnDefinition {
  name: string
  type: PrimitiveColumnType | string
  nullable?: boolean
  default?: string | number | boolean
  comment?: string
}

export interface SkipIndexDefinition {
  name: string
  expression: string
  type: 'minmax' | 'set' | 'bloom_filter' | 'tokenbf_v1' | 'ngrambf_v1'
  granularity: number
}

export interface TableDefinition {
  kind: 'table'
  database: string
  name: string
  columns: ColumnDefinition[]
  engine: string
  primaryKey: string[]
  orderBy: string[]
  partitionBy?: string
  ttl?: string
  settings?: Record<string, string | number | boolean>
  indexes?: SkipIndexDefinition[]
  comment?: string
}

export interface ViewDefinition {
  kind: 'view'
  database: string
  name: string
  as: string
  comment?: string
}

export interface MaterializedViewDefinition {
  kind: 'materialized_view'
  database: string
  name: string
  to: { database: string; name: string }
  as: string
  comment?: string
}

export type SchemaDefinition = TableDefinition | ViewDefinition | MaterializedViewDefinition

export interface ChxConfig {
  schema: string | string[]
  outDir?: string
  migrationsDir?: string
  metaDir?: string
  clickhouse?: {
    url: string
    username?: string
    password?: string
    database?: string
    secure?: boolean
  }
}

export function defineConfig(config: ChxConfig): ChxConfig {
  return config
}

export function table(input: Omit<TableDefinition, 'kind'>): TableDefinition {
  return { ...input, kind: 'table' }
}

export function view(input: Omit<ViewDefinition, 'kind'>): ViewDefinition {
  return { ...input, kind: 'view' }
}

export function materializedView(
  input: Omit<MaterializedViewDefinition, 'kind'>
): MaterializedViewDefinition {
  return { ...input, kind: 'materialized_view' }
}

export function schema(...definitions: SchemaDefinition[]): SchemaDefinition[] {
  return definitions
}

export function isSchemaDefinition(value: unknown): value is SchemaDefinition {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: string }).kind
  return kind === 'table' || kind === 'view' || kind === 'materialized_view'
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

  const dedup = new Map<string, SchemaDefinition>()
  for (const def of out) {
    const key = `${def.kind}:${def.database}.${def.name}`
    dedup.set(key, def)
  }
  return [...dedup.values()]
}

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
  return out
}

function renderTableSQL(def: TableDefinition): string {
  const columns = def.columns.map(renderColumn)
  const indexes = (def.indexes ?? []).map(
    (idx) =>
      `INDEX \`${idx.name}\` (${idx.expression}) TYPE ${idx.type} GRANULARITY ${idx.granularity}`
  )
  const body = [...columns, ...indexes].join(',\n  ')

  const clauses: string[] = []
  if (def.partitionBy) clauses.push(`PARTITION BY ${def.partitionBy}`)
  clauses.push(`PRIMARY KEY (${def.primaryKey.map((k) => `\`${k}\``).join(', ')})`)
  clauses.push(`ORDER BY (${def.orderBy.map((k) => `\`${k}\``).join(', ')})`)
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

function renderMaterializedViewSQL(def: MaterializedViewDefinition): string {
  return `CREATE MATERIALIZED VIEW IF NOT EXISTS ${def.database}.${def.name} TO ${def.to.database}.${def.to.name} AS\n${def.as};`
}

export function toCreateSQL(def: SchemaDefinition): string {
  if (def.kind === 'table') return renderTableSQL(def)
  if (def.kind === 'view') return renderViewSQL(def)
  return renderMaterializedViewSQL(def)
}

export interface Snapshot {
  generatedAt: string
  definitions: SchemaDefinition[]
}

export function createSnapshot(definitions: SchemaDefinition[]): Snapshot {
  return {
    generatedAt: new Date().toISOString(),
    definitions,
  }
}
