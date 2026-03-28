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

export interface QueryStatus {
  status: 'running' | 'finished' | 'failed' | 'unknown'
  readRows?: number
  readBytes?: number
  writtenRows?: number
  writtenBytes?: number
  elapsedMs?: number
  durationMs?: number
  error?: string
}

export interface ClickHouseExecutor {
  command(sql: string): Promise<void>
  query<T>(sql: string): Promise<T[]>
  insert<T extends Record<string, unknown>>(params: { table: string; values: T[] }): Promise<void>
  listSchemaObjects(): Promise<SchemaObjectRef[]>
  listTableDetails(databases: string[]): Promise<IntrospectedTable[]>

  /** Submit a query asynchronously. ClickHouse accepts the query and processes it server-side.
   *  Returns immediately without waiting for completion.
   *  @param sql - The SQL to execute
   *  @param queryId - Optional deterministic query_id (useful for resumability). Auto-generated if omitted.
   *  @returns The query_id assigned to this query. */
  submit(sql: string, queryId?: string): Promise<string>

  /** Check the status of a previously submitted query.
   *  Checks system.processes first (running?), then system.query_log (finished/failed?).
   *  @param queryId - The query_id returned by submit()
   *  @param options.afterTime - Only consider query_log entries for queries started at or after this ISO timestamp.
   *    Useful when resubmitting with the same query_id to ignore stale entries from previous attempts. */
  queryStatus(queryId: string, options?: { afterTime?: string }): Promise<QueryStatus>

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

function parseIndexType(value: string): Pick<SkipIndexDefinition, 'type' | 'typeArgs'> {
  const match = value.match(/^(\w+)\((.+)\)$/)
  const baseName = match?.[1] ?? value
  const args = match?.[2]

  switch (baseName) {
    case 'minmax':
      return args !== undefined ? { type: 'minmax', typeArgs: args } : { type: 'minmax' }
    case 'bloom_filter':
      return args !== undefined ? { type: 'bloom_filter', typeArgs: args } : { type: 'bloom_filter' }
    case 'tokenbf_v1':
      return { type: 'tokenbf_v1', typeArgs: args ?? '0' }
    case 'ngrambf_v1':
      return { type: 'ngrambf_v1', typeArgs: args ?? '0' }
    default:
      return { type: 'set', typeArgs: args ?? '0' }
  }
}

function normalizeIndexFromSystemRow(row: SystemSkippingIndexRow): SkipIndexDefinition {
  const parsed = parseIndexType(row.type)
  return {
    name: row.name,
    expression: normalizeSQLFragment(row.expr),
    granularity: row.granularity,
    ...parsed,
  } as SkipIndexDefinition
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

export function isUnknownDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (!('code' in error)) return false
  return String(error.code) === '81'
}

export {
  waitForDDLPropagation,
  waitForTable,
  waitForView,
  waitForColumn,
  waitForTableAbsent,
} from './ddl-propagation.js'

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

  const fireAndForgetClient = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    clickhouse_settings: {
      wait_end_of_query: 0,
    },
  })

  return {
    async command(sql: string): Promise<void> {
      try {
        await client.command({ query: sql, http_headers: { 'X-DDL': '1' } })
      } catch (error) {
        if (isUnknownDatabaseError(error)) {
          // The configured database doesn't exist yet. Retry without the
          // session database so that CREATE DATABASE can succeed.
          const fallback = createClient({
            url: config.url,
            username: config.username,
            password: config.password,
            clickhouse_settings: { wait_end_of_query: 1, async_insert: 0 },
          })
          try {
            await fallback.command({ query: sql, http_headers: { 'X-DDL': '1' } })
          } finally {
            await fallback.close()
          }
          return
        }
        wrapConnectionError(error, config.url)
      }
    },
    async query<T>(sql: string): Promise<T[]> {
      try {
        const result = await client.query({ query: sql, format: 'JSONEachRow', http_headers: { 'X-DDL': '1' } })
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
    async submit(sql: string, queryId?: string): Promise<string> {
      const id = queryId ?? crypto.randomUUID()
      try {
        await fireAndForgetClient.command({ query: sql, query_id: id })
      } catch (error) {
        wrapConnectionError(error, config.url)
      }
      return id
    },
    async queryStatus(queryId: string, options?: { afterTime?: string }): Promise<QueryStatus> {
      try {
        const running = await client.query({
          query: `SELECT read_rows, read_bytes, written_rows, written_bytes, elapsed FROM clusterAllReplicas('parallel_replicas', system.processes) WHERE query_id = {qid:String} SETTINGS skip_unavailable_shards = 1 LIMIT 1`,
          query_params: { qid: queryId },
          format: 'JSONEachRow',
        })
        const runningRows = await running.json<{
          read_rows: string
          read_bytes: string
          written_rows: string
          written_bytes: string
          elapsed: string
        }>()
        if (runningRows.length > 0) {
          const proc = runningRows[0]!
          return {
            status: 'running',
            readRows: Number(proc.read_rows),
            readBytes: Number(proc.read_bytes),
            writtenRows: Number(proc.written_rows),
            writtenBytes: Number(proc.written_bytes),
            elapsedMs: Math.round(Number(proc.elapsed) * 1000),
          }
        }

        const afterTime = options?.afterTime ?? '1970-01-01T00:00:00Z'
        const log = await client.query({
          query: `SELECT type, written_rows, written_bytes, query_duration_ms, exception
FROM clusterAllReplicas('parallel_replicas', system.query_log)
WHERE query_id = {qid:String}
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND is_initial_query = 1
  AND query_start_time >= parseDateTimeBestEffort({after:String})
ORDER BY event_time DESC
LIMIT 1
SETTINGS skip_unavailable_shards = 1`,
          query_params: { qid: queryId, after: afterTime },
          format: 'JSONEachRow',
        })
        const logRows = await log.json<{
          type: string
          written_rows: string
          written_bytes: string
          query_duration_ms: string
          exception: string
        }>()

        if (logRows.length === 0) {
          return { status: 'unknown' }
        }

        const row = logRows[0]!
        if (row.type === 'QueryFinish') {
          return {
            status: 'finished',
            writtenRows: Number(row.written_rows),
            writtenBytes: Number(row.written_bytes),
            durationMs: Number(row.query_duration_ms),
          }
        }

        return {
          status: 'failed',
          durationMs: Number(row.query_duration_ms),
          error: row.exception,
        }
      } catch (error) {
        wrapConnectionError(error, config.url)
      }
    },
    async close(): Promise<void> {
      await Promise.all([client.close(), fireAndForgetClient.close()])
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
