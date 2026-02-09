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
  | 'alter_table_add_index'
  | 'alter_table_modify_setting'

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
    type: typeof column.type === 'string' ? column.type.trim() : column.type,
    comment: column.comment?.trim(),
  }
}

function canonicalizeTable(def: TableDefinition): TableDefinition {
  const settings = def.settings
    ? Object.fromEntries(
        Object.entries(def.settings).sort(([a], [b]) => a.localeCompare(b))
      )
    : undefined

  const indexes = def.indexes
    ? sortByName(def.indexes).map((idx) => ({
        ...idx,
        expression: normalizeSQLFragment(idx.expression),
      }))
    : undefined

  return {
    ...def,
    database: def.database.trim(),
    name: def.name.trim(),
    engine: def.engine.trim(),
    columns: def.columns.map(canonicalizeColumn),
    primaryKey: [...def.primaryKey].map((k) => k.trim()),
    orderBy: [...def.orderBy].map((k) => k.trim()),
    partitionBy: def.partitionBy ? normalizeSQLFragment(def.partitionBy) : undefined,
    ttl: def.ttl ? normalizeSQLFragment(def.ttl) : undefined,
    settings,
    indexes,
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

function definitionKey(def: SchemaDefinition): string {
  return `${def.kind}:${def.database}.${def.name}`
}

function pushValidationIssue(
  issues: ValidationIssue[],
  def: SchemaDefinition,
  code: ValidationIssueCode,
  message: string
): void {
  issues.push({
    code,
    kind: def.kind,
    database: def.database,
    name: def.name,
    message,
  })
}

function validateTableDefinition(def: TableDefinition, issues: ValidationIssue[]): void {
  const columnSeen = new Set<string>()
  const columnSet = new Set<string>()
  for (const column of def.columns) {
    if (columnSeen.has(column.name)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_column_name',
        `Table ${def.database}.${def.name} has duplicate column name "${column.name}"`
      )
      continue
    }
    columnSeen.add(column.name)
    columnSet.add(column.name)
  }

  const indexSeen = new Set<string>()
  for (const index of def.indexes ?? []) {
    if (indexSeen.has(index.name)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_index_name',
        `Table ${def.database}.${def.name} has duplicate index name "${index.name}"`
      )
      continue
    }
    indexSeen.add(index.name)
  }

  for (const column of def.primaryKey) {
    if (!columnSet.has(column)) {
      pushValidationIssue(
        issues,
        def,
        'primary_key_missing_column',
        `Table ${def.database}.${def.name} primaryKey references missing column "${column}"`
      )
    }
  }

  for (const column of def.orderBy) {
    if (!columnSet.has(column)) {
      pushValidationIssue(
        issues,
        def,
        'order_by_missing_column',
        `Table ${def.database}.${def.name} orderBy references missing column "${column}"`
      )
    }
  }
}

export function validateDefinitions(definitions: SchemaDefinition[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const objectKeys = new Set<string>()
  for (const def of definitions) {
    const key = definitionKey(def)
    if (objectKeys.has(key)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_object_name',
        `Duplicate schema object definition "${def.kind}:${def.database}.${def.name}"`
      )
      continue
    }
    objectKeys.add(key)

    if (def.kind === 'table') {
      validateTableDefinition(def, issues)
    }
  }

  return issues
}

function assertValidDefinitions(definitions: SchemaDefinition[]): void {
  const issues = validateDefinitions(definitions)
  if (issues.length > 0) throw new ChxValidationError(issues)
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
  return canonicalizeDefinitions(out)
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
  assertValidDefinitions([def])
  if (def.kind === 'table') return renderTableSQL(def)
  if (def.kind === 'view') return renderViewSQL(def)
  return renderMaterializedViewSQL(def)
}

function createMap(definitions: SchemaDefinition[]): Map<string, SchemaDefinition> {
  return new Map(definitions.map((def) => [definitionKey(def), def]))
}

function addOperation(operations: MigrationOperation[], operation: MigrationOperation): void {
  operations.push(operation)
}

function pushDropOperation(
  operations: MigrationOperation[],
  def: SchemaDefinition,
  risk: RiskLevel = 'danger'
): void {
  if (def.kind === 'table') {
    addOperation(operations, {
      type: 'drop_table',
      key: definitionKey(def),
      risk,
      sql: `DROP TABLE IF EXISTS ${def.database}.${def.name};`,
    })
    return
  }
  if (def.kind === 'view') {
    addOperation(operations, {
      type: 'drop_view',
      key: definitionKey(def),
      risk,
      sql: `DROP VIEW IF EXISTS ${def.database}.${def.name};`,
    })
    return
  }
  addOperation(operations, {
    type: 'drop_materialized_view',
    key: definitionKey(def),
    risk,
    sql: `DROP VIEW IF EXISTS ${def.database}.${def.name};`,
  })
}

function pushCreateOperation(
  operations: MigrationOperation[],
  def: SchemaDefinition,
  risk: RiskLevel = 'safe'
): void {
  if (def.kind === 'table') {
    addOperation(operations, {
      type: 'create_table',
      key: definitionKey(def),
      risk,
      sql: toCreateSQL(def),
    })
    return
  }
  if (def.kind === 'view') {
    addOperation(operations, {
      type: 'create_view',
      key: definitionKey(def),
      risk,
      sql: toCreateSQL(def),
    })
    return
  }
  addOperation(operations, {
    type: 'create_materialized_view',
    key: definitionKey(def),
    risk,
    sql: toCreateSQL(def),
  })
}

function pushCreateDatabaseOperation(
  operations: MigrationOperation[],
  database: string,
  risk: RiskLevel = 'safe'
): void {
  addOperation(operations, {
    type: 'create_database',
    key: `database:${database}`,
    risk,
    sql: `CREATE DATABASE IF NOT EXISTS ${database};`,
  })
}

function renderAlterAddColumn(def: TableDefinition, column: ColumnDefinition): string {
  return `ALTER TABLE ${def.database}.${def.name} ADD COLUMN IF NOT EXISTS ${renderColumn(column)};`
}

function renderAlterAddIndex(def: TableDefinition, index: SkipIndexDefinition): string {
  return `ALTER TABLE ${def.database}.${def.name} ADD INDEX IF NOT EXISTS \`${index.name}\` (${index.expression}) TYPE ${index.type} GRANULARITY ${index.granularity};`
}

function renderAlterModifySetting(
  def: TableDefinition,
  key: string,
  value: string | number | boolean
): string {
  return `ALTER TABLE ${def.database}.${def.name} MODIFY SETTING ${key} = ${value};`
}

function diffTables(oldDef: TableDefinition, newDef: TableDefinition): MigrationOperation[] {
  const ops: MigrationOperation[] = []

  const oldColumns = new Map(oldDef.columns.map((c) => [c.name, c]))
  for (const column of newDef.columns) {
    if (!oldColumns.has(column.name)) {
      addOperation(ops, {
        type: 'alter_table_add_column',
        key: `table:${newDef.database}.${newDef.name}:column:${column.name}`,
        risk: 'safe',
        sql: renderAlterAddColumn(newDef, column),
      })
    }
  }

  const oldIndexes = new Map((oldDef.indexes ?? []).map((idx) => [idx.name, idx]))
  for (const idx of newDef.indexes ?? []) {
    if (!oldIndexes.has(idx.name)) {
      addOperation(ops, {
        type: 'alter_table_add_index',
        key: `table:${newDef.database}.${newDef.name}:index:${idx.name}`,
        risk: 'caution',
        sql: renderAlterAddIndex(newDef, idx),
      })
    }
  }

  const oldSettings = oldDef.settings ?? {}
  const newSettings = newDef.settings ?? {}
  const allSettings = [...new Set([...Object.keys(oldSettings), ...Object.keys(newSettings)])].sort()
  for (const key of allSettings) {
    const nextValue = newSettings[key]
    if (nextValue === undefined) continue
    if (!(key in oldSettings) || oldSettings[key] !== nextValue) {
      addOperation(ops, {
        type: 'alter_table_modify_setting',
        key: `table:${newDef.database}.${newDef.name}:setting:${key}`,
        risk: 'caution',
        sql: renderAlterModifySetting(newDef, key, nextValue),
      })
    }
  }

  return ops
}

export function planDiff(oldDefinitions: SchemaDefinition[], newDefinitions: SchemaDefinition[]): MigrationPlan {
  const oldCanonical = canonicalizeDefinitions(oldDefinitions)
  const newCanonical = canonicalizeDefinitions(newDefinitions)
  assertValidDefinitions(newCanonical)
  const oldMap = createMap(oldCanonical)
  const newMap = createMap(newCanonical)
  const operations: MigrationOperation[] = []
  const databasesToCreate = new Set<string>()

  for (const oldDef of oldCanonical) {
    if (newMap.has(definitionKey(oldDef))) continue
    pushDropOperation(operations, oldDef, 'danger')
  }

  for (const newDef of newCanonical) {
    const key = definitionKey(newDef)
    const oldDef = oldMap.get(key)
    if (!oldDef) continue

    if (newDef.kind === 'table' && oldDef.kind === 'table') {
      operations.push(...diffTables(oldDef, newDef))
      continue
    }

    if (newDef.kind === oldDef.kind && newDef.kind === 'view' && oldDef.kind === 'view') {
      if (newDef.as !== oldDef.as || newDef.comment !== oldDef.comment) {
        pushDropOperation(operations, oldDef, 'caution')
        pushCreateOperation(operations, newDef, 'caution')
      }
      continue
    }

    if (
      newDef.kind === oldDef.kind &&
      newDef.kind === 'materialized_view' &&
      oldDef.kind === 'materialized_view'
    ) {
      const changed =
        newDef.as !== oldDef.as ||
        newDef.comment !== oldDef.comment ||
        newDef.to.database !== oldDef.to.database ||
        newDef.to.name !== oldDef.to.name
      if (changed) {
        pushDropOperation(operations, oldDef, 'caution')
        pushCreateOperation(operations, newDef, 'caution')
      }
      continue
    }

    if (newDef.kind !== oldDef.kind) {
      pushDropOperation(operations, oldDef, 'danger')
    }
  }

  for (const newDef of newCanonical) {
    const key = definitionKey(newDef)
    const oldDef = oldMap.get(key)
    if (oldDef && oldDef.kind === newDef.kind) continue

    databasesToCreate.add(newDef.database)
    pushCreateOperation(operations, newDef, 'safe')
  }

  for (const database of [...databasesToCreate].sort((a, b) => a.localeCompare(b))) {
    pushCreateDatabaseOperation(operations, database, 'safe')
  }

  operations.sort((a, b) => {
    const rank = (op: MigrationOperation): number => {
      if (op.type.startsWith('drop_')) return 0
      if (op.type.startsWith('alter_')) return 1
      if (op.type === 'create_database') return 2
      return 3
    }
    const rankOrder = rank(a) - rank(b)
    if (rankOrder !== 0) return rankOrder
    return a.key.localeCompare(b.key)
  })

  const riskSummary: Record<RiskLevel, number> = { safe: 0, caution: 0, danger: 0 }
  for (const operation of operations) {
    riskSummary[operation.risk] += 1
  }

  return { operations, riskSummary }
}

export function createSnapshot(definitions: SchemaDefinition[]): Snapshot {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    definitions: canonicalizeDefinitions(definitions),
  }
}
