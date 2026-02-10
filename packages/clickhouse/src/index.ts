import { createClient } from '@clickhouse/client'
import type { ChxConfig, ColumnDefinition, ProjectionDefinition, SkipIndexDefinition } from '@chx/core'

export interface ClickHouseExecutor {
  execute(sql: string): Promise<void>
  query<T>(sql: string): Promise<T[]>
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

export function inferSchemaKindFromEngine(engine: string): SchemaObjectRef['kind'] | null {
  if (engine === 'View') return 'view'
  if (engine === 'MaterializedView') return 'materialized_view'
  if (!engine || engine === 'Dictionary') return null
  return 'table'
}

function splitTopLevelCommaSeparated(input: string): string[] {
  const out: string[] = []
  let current = ''
  let depth = 0
  let inString = false
  let stringQuote = "'"
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (!char) continue
    if (inString) {
      current += char
      if (char === stringQuote && input[i - 1] !== '\\') {
        inString = false
      }
      continue
    }
    if (char === "'" || char === '"') {
      inString = true
      stringQuote = char
      current += char
      continue
    }
    if (char === '(') {
      depth += 1
      current += char
      continue
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }
    if (char === ',' && depth === 0) {
      const chunk = current.trim()
      if (chunk.length > 0) out.push(chunk)
      current = ''
      continue
    }
    current += char
  }
  const last = current.trim()
  if (last.length > 0) out.push(last)
  return out
}

function normalizeSQLFragment(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function parseSettingsFromCreateTableQuery(createTableQuery: string | undefined): Record<string, string> {
  if (!createTableQuery) return {}
  const settingsMatch = createTableQuery.match(/\bSETTINGS\b([\s\S]*?)(?:;|$)/i)
  if (!settingsMatch?.[1]) return {}
  const rawSettings = settingsMatch[1].trim()
  if (!rawSettings) return {}
  const items = splitTopLevelCommaSeparated(rawSettings)
  const out: Record<string, string> = {}
  for (const item of items) {
    const eq = item.indexOf('=')
    if (eq === -1) continue
    const key = item.slice(0, eq).trim()
    const value = item.slice(eq + 1).trim()
    if (!key) continue
    out[key] = value
  }
  return out
}

export function parseTTLFromCreateTableQuery(createTableQuery: string | undefined): string | undefined {
  if (!createTableQuery) return undefined
  const ttlMatch = createTableQuery.match(/\bTTL\b([\s\S]*?)(?:\bSETTINGS\b|;|$)/i)
  const raw = ttlMatch?.[1]?.trim()
  if (!raw) return undefined
  return normalizeSQLFragment(raw)
}

function parseClauseFromCreateTableQuery(
  createTableQuery: string | undefined,
  clausePattern: RegExp,
  stopPattern: RegExp
): string | undefined {
  if (!createTableQuery) return undefined
  const start = createTableQuery.match(clausePattern)
  if (!start || start.index === undefined) return undefined
  const afterClause = createTableQuery.slice(start.index + start[0].length)
  const stop = afterClause.match(stopPattern)
  const raw = (stop ? afterClause.slice(0, stop.index) : afterClause).trim()
  if (!raw) return undefined
  return normalizeSQLFragment(raw)
}

export function parseEngineFromCreateTableQuery(createTableQuery: string | undefined): string | undefined {
  if (!createTableQuery) return undefined
  const match = createTableQuery.match(/\bENGINE\s*=\s*([^\n;]+)/i)
  const raw = match?.[1]?.trim()
  if (!raw) return undefined
  return normalizeSQLFragment(raw)
}

export function parsePrimaryKeyFromCreateTableQuery(
  createTableQuery: string | undefined
): string | undefined {
  return parseClauseFromCreateTableQuery(
    createTableQuery,
    /\bPRIMARY\s+KEY\b/i,
    /\bORDER\s+BY\b|\bPARTITION\s+BY\b|\bUNIQUE\s+KEY\b|\bSAMPLE\s+BY\b|\bTTL\b|\bSETTINGS\b|;|$/i
  )
}

export function parseOrderByFromCreateTableQuery(createTableQuery: string | undefined): string | undefined {
  return parseClauseFromCreateTableQuery(
    createTableQuery,
    /\bORDER\s+BY\b/i,
    /\bPRIMARY\s+KEY\b|\bPARTITION\s+BY\b|\bUNIQUE\s+KEY\b|\bSAMPLE\s+BY\b|\bTTL\b|\bSETTINGS\b|;|$/i
  )
}

export function parsePartitionByFromCreateTableQuery(
  createTableQuery: string | undefined
): string | undefined {
  return parseClauseFromCreateTableQuery(
    createTableQuery,
    /\bPARTITION\s+BY\b/i,
    /\bPRIMARY\s+KEY\b|\bORDER\s+BY\b|\bUNIQUE\s+KEY\b|\bSAMPLE\s+BY\b|\bTTL\b|\bSETTINGS\b|;|$/i
  )
}

export function parseUniqueKeyFromCreateTableQuery(
  createTableQuery: string | undefined
): string | undefined {
  return parseClauseFromCreateTableQuery(
    createTableQuery,
    /\bUNIQUE\s+KEY\b/i,
    /\bPRIMARY\s+KEY\b|\bORDER\s+BY\b|\bPARTITION\s+BY\b|\bSAMPLE\s+BY\b|\bTTL\b|\bSETTINGS\b|;|$/i
  )
}

function extractCreateTableBody(createTableQuery: string | undefined): string | undefined {
  if (!createTableQuery) return undefined
  const engineMatch = /\)\s*ENGINE\s*=/i.exec(createTableQuery)
  if (!engineMatch || engineMatch.index === undefined) return undefined
  const left = createTableQuery.slice(0, engineMatch.index + 1)
  const openIndex = left.indexOf('(')
  if (openIndex === -1) return undefined

  let depth = 0
  let inString = false
  let stringQuote = "'"
  for (let i = openIndex; i < left.length; i += 1) {
    const char = left[i]
    if (!char) continue
    if (inString) {
      if (char === stringQuote && left[i - 1] !== '\\') {
        inString = false
      }
      continue
    }
    if (char === "'" || char === '"') {
      inString = true
      stringQuote = char
      continue
    }
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0) {
        const body = left.slice(openIndex + 1, i).trim()
        return body.length > 0 ? body : undefined
      }
    }
  }

  return undefined
}

export function parseProjectionsFromCreateTableQuery(
  createTableQuery: string | undefined
): ProjectionDefinition[] {
  const body = extractCreateTableBody(createTableQuery)
  if (!body) return []
  const parts = splitTopLevelCommaSeparated(body)
  const projections: ProjectionDefinition[] = []
  for (const part of parts) {
    const match = part.match(
      /^\s*PROJECTION\s+(`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s*\(([\s\S]*)\)\s*$/i
    )
    if (!match) continue
    const name = (match[2] ?? match[3] ?? '').trim()
    const query = normalizeSQLFragment((match[4] ?? '').trim())
    if (!name || !query) continue
    projections.push({ name, query })
  }
  return projections
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
