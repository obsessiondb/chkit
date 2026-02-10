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

export interface ProjectionDefinition {
  name: string
  query: string
}

export interface TableDefinition {
  kind: 'table'
  database: string
  name: string
  columns: ColumnDefinition[]
  engine: string
  primaryKey: string[]
  orderBy: string[]
  uniqueKey?: string[]
  partitionBy?: string
  ttl?: string
  settings?: Record<string, string | number | boolean>
  indexes?: SkipIndexDefinition[]
  projections?: ProjectionDefinition[]
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
  check?: {
    failOnPending?: boolean
    failOnChecksumMismatch?: boolean
    failOnDrift?: boolean
  }
  safety?: {
    allowDestructive?: boolean
    requireConfirmOnDanger?: boolean
  }
  clickhouse?: {
    url: string
    username?: string
    password?: string
    database?: string
    secure?: boolean
  }
}

export interface SnapshotV1 {
  version: 1
  generatedAt: string
  definitions: SchemaDefinition[]
}

export type Snapshot = SnapshotV1

export type RiskLevel = 'safe' | 'caution' | 'danger'

export type MigrationOperationType =
  | 'create_database'
  | 'create_table'
  | 'drop_table'
  | 'create_view'
  | 'drop_view'
  | 'create_materialized_view'
  | 'drop_materialized_view'
  | 'alter_table_add_column'
  | 'alter_table_modify_column'
  | 'alter_table_drop_column'
  | 'alter_table_add_index'
  | 'alter_table_add_projection'
  | 'alter_table_modify_setting'
  | 'alter_table_drop_index'
  | 'alter_table_drop_projection'
  | 'alter_table_reset_setting'
  | 'alter_table_modify_ttl'

export interface MigrationOperation {
  type: MigrationOperationType
  key: string
  risk: RiskLevel
  sql: string
}

export interface MigrationPlan {
  operations: MigrationOperation[]
  riskSummary: Record<RiskLevel, number>
}

export type ValidationIssueCode =
  | 'duplicate_object_name'
  | 'duplicate_column_name'
  | 'duplicate_index_name'
  | 'duplicate_projection_name'
  | 'primary_key_missing_column'
  | 'order_by_missing_column'

export interface ValidationIssue {
  code: ValidationIssueCode
  kind: SchemaDefinition['kind']
  database: string
  name: string
  message: string
}

export class ChxValidationError extends Error {
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super(
      `Schema validation failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}`
    )
    this.name = 'ChxValidationError'
    this.issues = issues
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
