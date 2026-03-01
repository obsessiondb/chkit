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
  close(): Promise<void>
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

export interface ParsedSystemColumnType {
  type: string
  nullable?: boolean
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

function unwrapTypeWrapper(type: string, wrapper: string): string | null {
  const trimmed = type.trim()
  const prefix = `${wrapper}(`
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(')')) return null
  return trimmed.slice(prefix.length, -1).trim()
}

export function parseSystemColumnType(type: string): ParsedSystemColumnType {
  let normalizedType = type.trim()
  let nullable = false

  const outerNullable = unwrapTypeWrapper(normalizedType, 'Nullable')
  if (outerNullable) {
    normalizedType = outerNullable
    nullable = true
  }

  const lowCardinality = unwrapTypeWrapper(normalizedType, 'LowCardinality')
  if (lowCardinality) {
    const lowCardinalityNullable = unwrapTypeWrapper(lowCardinality, 'Nullable')
    if (lowCardinalityNullable) {
      normalizedType = `LowCardinality(${lowCardinalityNullable})`
      nullable = true
    }
  }

  return {
    type: normalizedType,
    nullable: nullable || undefined,
  }
}

function normalizeColumnFromSystemRow(row: SystemColumnRow): ColumnDefinition {
  const normalizedType = parseSystemColumnType(row.type)
  let defaultValue: ColumnDefinition['default'] | undefined
  if (row.default_expression && row.default_kind === 'DEFAULT') {
    defaultValue = normalizeSQLFragment(row.default_expression)
  }
  return {
    name: row.name,
    type: normalizedType.type,
    nullable: normalizedType.nullable,
    default: defaultValue,
    comment: row.comment?.trim() || undefined,
  }
}

export function normalizeSkipIndexType(value: string): SkipIndexDefinition['type'] {
  return value.trim()
}

function normalizeIndexFromSystemRow(row: SystemSkippingIndexRow): SkipIndexDefinition {
  return {
    name: row.name,
    expression: normalizeSQLFragment(row.expr),
    type: normalizeSkipIndexType(row.type),
    granularity: row.granularity,
  }
}

const NETWORK_ERROR_LABELS: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'host not found',
  ETIMEDOUT: 'connection timed out',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
}

function wrapConnectionError(error: unknown, url: string): never {
  if (error instanceof Error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    const label = NETWORK_ERROR_LABELS[code]
    if (label) {
      throw new Error(`Could not connect to ClickHouse at ${url} (${label})`)
    }
  }
  throw error
}

export function createClickHouseExecutor(config: NonNullable<ChxConfig['clickhouse']>): ClickHouseExecutor {
  const client = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    session_id: crypto.randomUUID(),
    clickhouse_settings: {
      wait_end_of_query: 1,
      async_insert: 0,
    },
  })

  return {
    async execute(sql: string): Promise<void> {
      try {
        await client.command({ query: sql })
      } catch (error) {
        wrapConnectionError(error, config.url)
      }
    },
    async query<T>(sql: string): Promise<T[]> {
      try {
        const result = await client.query({ query: sql, format: 'JSONEachRow' })
        return result.json<T>()
      } catch (error) {
        wrapConnectionError(error, config.url)
      }
    },
    async insert<T extends Record<string, unknown>>(params: { table: string; values: T[] }): Promise<void> {
      try {
        await client.insert({
          table: params.table,
          values: params.values,
          format: 'JSONEachRow',
        })
      } catch (error) {
        wrapConnectionError(error, config.url)
      }
    },
    async close(): Promise<void> {
      await client.close()
    },
    async listSchemaObjects(): Promise<SchemaObjectRef[]> {
      const rows = await this.query<SystemTableRow>(
        `SELECT database, name, engine
FROM system.tables
WHERE is_temporary = 0
  AND database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
  AND name NOT LIKE '_chkit_%'`
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
