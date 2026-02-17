import { createClient } from '@clickhouse/client'
import {
  normalizeSQLFragment,
  type ChxConfig,
  type ColumnDefinition,
  type ProjectionDefinition,
  type SkipIndexDefinition,
} from '@chkit/core'
import {
  parseEngineFromCreateTableQuery,
  parseOrderByFromCreateTableQuery,
  parsePartitionByFromCreateTableQuery,
  parsePrimaryKeyFromCreateTableQuery,
  parseProjectionsFromCreateTableQuery,
  parseSettingsFromCreateTableQuery,
  parseTTLFromCreateTableQuery,
  parseUniqueKeyFromCreateTableQuery,
} from './create-table-parser.js'

export interface ClickHouseExecutor {
  execute(sql: string): Promise<void>
  query<T>(sql: string): Promise<T[]>
  insert<T extends Record<string, unknown>>(params: { table: string; values: T[] }): Promise<void>
  listSchemaObjects(): Promise<SchemaObjectRef[]>
  listTableDetails(databases: string[]): Promise<IntrospectedTable[]>
}

export interface SchemaObjectRef {
  kind: 'table' | 'view' | 'materialized_view'
  database: string
  name: string
}

interface SystemTableRow {
  database: string
  name: string
  engine: string
  create_table_query?: string
}

interface SystemColumnRow {
  database: string
  table: string
  name: string
  type: string
  default_kind?: string
  default_expression?: string
  comment?: string
  position: number
}

interface SystemSkippingIndexRow {
  database: string
  table: string
  name: string
  expr: string
  type: string
  granularity: number
}

export interface IntrospectedTable {
  database: string
  name: string
  engine?: string
  primaryKey?: string
  orderBy?: string
  uniqueKey?: string
  partitionBy?: string
  columns: ColumnDefinition[]
  settings: Record<string, string>
  indexes: SkipIndexDefinition[]
  projections: ProjectionDefinition[]
  ttl?: string
}

export {
  parseEngineFromCreateTableQuery,
  parseOrderByFromCreateTableQuery,
  parsePartitionByFromCreateTableQuery,
  parsePrimaryKeyFromCreateTableQuery,
  parseProjectionsFromCreateTableQuery,
  parseSettingsFromCreateTableQuery,
  parseTTLFromCreateTableQuery,
  parseUniqueKeyFromCreateTableQuery,
} from './create-table-parser.js'

export function inferSchemaKindFromEngine(engine: string): SchemaObjectRef['kind'] | null {
  if (engine === 'View') return 'view'
  if (engine === 'MaterializedView') return 'materialized_view'
  if (!engine || engine === 'Dictionary') return null
  return 'table'
}


function normalizeColumnFromSystemRow(row: SystemColumnRow): ColumnDefinition {
  const nullableMatch = row.type.match(/^Nullable\((.+)\)$/)
  const type = nullableMatch?.[1] ? nullableMatch[1] : row.type
  const nullable = Boolean(nullableMatch?.[1])
  let defaultValue: ColumnDefinition['default'] | undefined
  if (row.default_expression && row.default_kind === 'DEFAULT') {
    defaultValue = normalizeSQLFragment(row.default_expression)
  }
  return {
    name: row.name,
    type,
    nullable: nullable || undefined,
    default: defaultValue,
    comment: row.comment?.trim() || undefined,
  }
}

function normalizeIndexType(value: string): SkipIndexDefinition['type'] {
  if (value === 'minmax') return 'minmax'
  if (value === 'set') return 'set'
  if (value === 'bloom_filter') return 'bloom_filter'
  if (value === 'tokenbf_v1') return 'tokenbf_v1'
  if (value === 'ngrambf_v1') return 'ngrambf_v1'
  return 'set'
}

function normalizeIndexFromSystemRow(row: SystemSkippingIndexRow): SkipIndexDefinition {
  return {
    name: row.name,
    expression: normalizeSQLFragment(row.expr),
    type: normalizeIndexType(row.type),
    granularity: row.granularity,
  }
}

export function createClickHouseExecutor(config: NonNullable<ChxConfig['clickhouse']>): ClickHouseExecutor {
  const client = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    clickhouse_settings: {
      wait_end_of_query: 1,
    },
  })

  return {
    async execute(sql: string): Promise<void> {
      await client.command({ query: sql })
    },
    async query<T>(sql: string): Promise<T[]> {
      const result = await client.query({ query: sql, format: 'JSONEachRow' })
      return result.json<T>()
    },
    async insert<T extends Record<string, unknown>>(params: { table: string; values: T[] }): Promise<void> {
      await client.insert({
        table: params.table,
        values: params.values,
        format: 'JSONEachRow',
      })
    },
    async listSchemaObjects(): Promise<SchemaObjectRef[]> {
      const rows = await this.query<SystemTableRow>(
        `SELECT database, name, engine
FROM system.tables
WHERE is_temporary = 0
  AND database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')`
      )

      const out: SchemaObjectRef[] = []
      for (const row of rows) {
        const kind = inferSchemaKindFromEngine(row.engine)
        if (!kind) continue
        out.push({
          kind,
          database: row.database,
          name: row.name,
        })
      }
      return out
    },
    async listTableDetails(databases: string[]): Promise<IntrospectedTable[]> {
      if (databases.length === 0) return []

      const quotedDatabases = databases.map((dbName) => `'${dbName.replace(/'/g, "''")}'`).join(', ')
      const tables = await this.query<SystemTableRow>(
        `SELECT database, name, engine, create_table_query
FROM system.tables
WHERE is_temporary = 0
  AND database IN (${quotedDatabases})`
      )
      const tableRows = tables.filter((row) => inferSchemaKindFromEngine(row.engine) === 'table')
      if (tableRows.length === 0) return []

      const columns = await this.query<SystemColumnRow>(
        `SELECT database, table, name, type, default_kind, default_expression, comment, position
FROM system.columns
WHERE database IN (${quotedDatabases})`
      )
      const indexes = await this.query<SystemSkippingIndexRow>(
        `SELECT database, table, name, expr, type, granularity
FROM system.data_skipping_indices
WHERE database IN (${quotedDatabases})`
      )

      const columnsByTable = new Map<string, SystemColumnRow[]>()
      for (const row of columns) {
        const key = `${row.database}.${row.table}`
        const rows = columnsByTable.get(key)
        if (rows) {
          rows.push(row)
        } else {
          columnsByTable.set(key, [row])
        }
      }

      const indexesByTable = new Map<string, SystemSkippingIndexRow[]>()
      for (const row of indexes) {
        const key = `${row.database}.${row.table}`
        const rows = indexesByTable.get(key)
        if (rows) {
          rows.push(row)
        } else {
          indexesByTable.set(key, [row])
        }
      }

      return tableRows
        .map((row) => {
          const key = `${row.database}.${row.name}`
          const columnRows = (columnsByTable.get(key) ?? []).sort((a, b) => a.position - b.position)
          const indexRows = indexesByTable.get(key) ?? []
          return {
            database: row.database,
            name: row.name,
            engine: parseEngineFromCreateTableQuery(row.create_table_query),
            primaryKey: parsePrimaryKeyFromCreateTableQuery(row.create_table_query),
            orderBy: parseOrderByFromCreateTableQuery(row.create_table_query),
            uniqueKey: parseUniqueKeyFromCreateTableQuery(row.create_table_query),
            partitionBy: parsePartitionByFromCreateTableQuery(row.create_table_query),
            columns: columnRows.map(normalizeColumnFromSystemRow),
            settings: parseSettingsFromCreateTableQuery(row.create_table_query),
            indexes: indexRows.map(normalizeIndexFromSystemRow),
            projections: parseProjectionsFromCreateTableQuery(row.create_table_query),
            ttl: parseTTLFromCreateTableQuery(row.create_table_query),
          }
        })
        .sort((a, b) => {
          const dbOrder = a.database.localeCompare(b.database)
          if (dbOrder !== 0) return dbOrder
          return a.name.localeCompare(b.name)
        })
    },
  }
}
