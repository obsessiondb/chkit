import { createRequire } from 'node:module'
import { createClient, type ClickHouseSettings } from '@clickhouse/client'
import {
  normalizeSQLFragment,
  parseCodec,
  type ChxConfig,
  type ColumnDefinition,
  type ProjectionDefinition,
  type SkipIndexDefinition,
} from '@chkit/core'
import { getLogger } from '@logtape/logtape'
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

const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
const CHKIT_APPLICATION_ID = `chkit/${pkg.version}`

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

export type { ClickHouseSettings }

export interface ClickHouseInsertParams<T extends Record<string, unknown>> {
  table: string
  values: T[]
  compressed?: boolean
}

export interface ClickHouseExecutor {
  command(sql: string): Promise<void>
  query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]>
  insert<T extends Record<string, unknown>>(params: ClickHouseInsertParams<T>): Promise<void>
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

export interface SystemTableRow {
  database: string
  name: string
  engine: string
  create_table_query?: string
}

export interface SystemColumnRow {
  database: string
  table: string
  name: string
  type: string
  default_kind?: string
  default_expression?: string
  comment?: string
  position: number
  compression_codec?: string
}

export interface SystemSkippingIndexRow {
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

type ClickHouseClient = ReturnType<typeof createClient>
type ClickHouseConfig = NonNullable<ChxConfig['clickhouse']>
type ClickHouseClientOptions = {
  compression?: {
    request?: boolean
    response?: boolean
  }
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


export function normalizeColumnFromSystemRow(row: SystemColumnRow): ColumnDefinition {
  const nullableMatch = row.type.match(/^Nullable\((.+)\)$/)
  const type = nullableMatch?.[1] ? nullableMatch[1] : row.type
  const nullable = Boolean(nullableMatch?.[1])
  let defaultValue: ColumnDefinition['default'] | undefined
  if (row.default_expression && row.default_kind === 'DEFAULT') {
    defaultValue = normalizeSQLFragment(row.default_expression)
  }
  const codecSteps = parseCodec(row.compression_codec)
  return {
    name: row.name,
    type,
    nullable: nullable || undefined,
    default: defaultValue,
    comment: row.comment?.trim() || undefined,
    codec: codecSteps,
  }
}

type ParsedIndexShape =
  | { type: 'minmax' }
  | { type: 'set'; maxRows: number }
  | { type: 'bloom_filter'; falsePositiveRate?: number }
  | { type: 'tokenbf_v1'; sizeBytes: number; hashFunctions: number; randomSeed: number }
  | {
      type: 'ngrambf_v1'
      ngramSize: number
      sizeBytes: number
      hashFunctions: number
      randomSeed: number
    }

function splitArgs(args: string | undefined): number[] {
  if (args === undefined) return []
  return args
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => !Number.isNaN(value))
}

function parseIndexType(value: string): ParsedIndexShape {
  const match = value.match(/^(\w+)\((.+)\)$/)
  const baseName = match?.[1] ?? value
  const args = splitArgs(match?.[2])

  switch (baseName) {
    case 'minmax':
      return { type: 'minmax' }
    case 'bloom_filter':
      return args.length > 0
        ? { type: 'bloom_filter', falsePositiveRate: args[0]! }
        : { type: 'bloom_filter' }
    case 'tokenbf_v1':
      return {
        type: 'tokenbf_v1',
        sizeBytes: args[0] ?? 0,
        hashFunctions: args[1] ?? 0,
        randomSeed: args[2] ?? 0,
      }
    case 'ngrambf_v1':
      return {
        type: 'ngrambf_v1',
        ngramSize: args[0] ?? 0,
        sizeBytes: args[1] ?? 0,
        hashFunctions: args[2] ?? 0,
        randomSeed: args[3] ?? 0,
      }
    default:
      return { type: 'set', maxRows: args[0] ?? 0 }
  }
}

export function normalizeIndexFromSystemRow(row: SystemSkippingIndexRow): SkipIndexDefinition {
  const parsed = parseIndexType(row.type)
  return {
    name: row.name,
    expression: normalizeSQLFragment(row.expr),
    granularity: row.granularity,
    ...parsed,
  }
}

export function buildIntrospectedTables(
  tables: SystemTableRow[],
  columns: SystemColumnRow[],
  indexes: SystemSkippingIndexRow[],
): IntrospectedTable[] {
  const tableRows = tables.filter((row) => inferSchemaKindFromEngine(row.engine) === 'table')
  if (tableRows.length === 0) return []

  const columnsByTable = new Map<string, SystemColumnRow[]>()
  for (const row of columns) {
    const key = `${row.database}.${row.table}`
    const rows = columnsByTable.get(key)
    if (rows) rows.push(row)
    else columnsByTable.set(key, [row])
  }

  const indexesByTable = new Map<string, SystemSkippingIndexRow[]>()
  for (const row of indexes) {
    const key = `${row.database}.${row.table}`
    const rows = indexesByTable.get(key)
    if (rows) rows.push(row)
    else indexesByTable.set(key, [row])
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
      const isLocalhostDefault = /^https?:\/\/(localhost|127\.0\.0\.1):8123\/?$/.test(url)
      const envUnset = !process.env.CLICKHOUSE_URL
      const hint = isLocalhostDefault && envUnset
        ? '\n  Hint: CLICKHOUSE_URL is not set — chkit fell back to the default localhost endpoint. Set CLICKHOUSE_URL to point at your ClickHouse instance.'
        : ''
      throw new Error(`Could not connect to ClickHouse at ${url} (${label})${hint}`)
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

function parseSummaryFromHeaders(headers: Record<string, string | string[] | undefined>): {
  read_rows: string
  read_bytes: string
  written_rows: string
  written_bytes: string
  result_rows: string
  result_bytes: string
  elapsed_ns: string
} | undefined {
  const raw = headers['x-clickhouse-summary']
  if (!raw || typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function logProfiling(
  logger: ReturnType<typeof getLogger>,
  query: string,
  queryId: string,
  summary?: {
    read_rows: string
    read_bytes: string
    written_rows: string
    written_bytes: string
    result_rows?: string
    result_bytes?: string
    elapsed_ns: string
  },
): void {
  logger.trace('Query completed: {query}', {
    query,
    queryId,
    readRows: Number(summary?.read_rows ?? 0),
    readBytes: Number(summary?.read_bytes ?? 0),
    writtenRows: Number(summary?.written_rows ?? 0),
    writtenBytes: Number(summary?.written_bytes ?? 0),
    elapsedMs: Number(summary?.elapsed_ns ?? 0) / 1_000_000,
    resultRows: Number(summary?.result_rows ?? 0),
    resultBytes: Number(summary?.result_bytes ?? 0),
  })
}

const DEFAULT_CLICKHOUSE_SETTINGS: ClickHouseSettings = {
  wait_end_of_query: 1,
  async_insert: 0,
  send_progress_in_http_headers: 1,
}

export function createStatelessClickHouseClient(
  config: ClickHouseConfig,
  clickhouseSettings: ClickHouseSettings = DEFAULT_CLICKHOUSE_SETTINGS,
  options: ClickHouseClientOptions = {},
): ClickHouseClient {
  return createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    application: CHKIT_APPLICATION_ID,
    clickhouse_settings: clickhouseSettings,
    ...(options.compression ? { compression: options.compression } : {}),
  })
}

/**
 * Creates a ClickHouse client that sends one session_id with every request.
 * Use only for workflows that need session state, such as temporary tables or
 * session-level settings. ClickHouse allows only one in-flight query per HTTP
 * session, so callers must serialize all requests made through this client.
 */
export function createSessionClickHouseClient(
  config: ClickHouseConfig,
  clickhouseSettings: ClickHouseSettings = DEFAULT_CLICKHOUSE_SETTINGS,
  sessionId = crypto.randomUUID(),
  options: ClickHouseClientOptions = {},
): ClickHouseClient {
  return createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    session_id: sessionId,
    application: CHKIT_APPLICATION_ID,
    clickhouse_settings: clickhouseSettings,
    ...(options.compression ? { compression: options.compression } : {}),
  })
}

export function createExecutorWithClient(
  config: ClickHouseConfig,
  client: ClickHouseClient,
  options: { createCompressedClient?: () => ClickHouseClient } = {},
): ClickHouseExecutor {
  const profiler = getLogger(['chkit', 'profiling'])

  const fireAndForgetClient = createStatelessClickHouseClient(config, { wait_end_of_query: 0 })
  let compressedClient: ClickHouseClient | undefined

  return {
    async command(sql: string): Promise<void> {
      try {
        const result = await client.command({ query: sql, http_headers: { 'X-DDL': '1' } })
        logProfiling(profiler, sql, result.query_id, result.summary)
      } catch (error) {
        if (isUnknownDatabaseError(error)) {
          const fallback = createClient({
            url: config.url,
            username: config.username,
            password: config.password,
            application: CHKIT_APPLICATION_ID,
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
    async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
      try {
        const result = await client.query({ query: sql, format: 'JSONEachRow', http_headers: { 'X-DDL': '1' }, ...(settings ? { clickhouse_settings: settings } : {}) })
        const rows = await result.json<T>()
        logProfiling(profiler, sql, result.query_id, parseSummaryFromHeaders(result.response_headers))
        return rows
      } catch (error) {
        wrapConnectionError(error, config.url)
      }
    },
    async insert<T extends Record<string, unknown>>(params: ClickHouseInsertParams<T>): Promise<void> {
      try {
        let insertClient = client
        if (params.compressed === true) {
          if (!compressedClient) {
            compressedClient = options.createCompressedClient?.() ?? createStatelessClickHouseClient(
              config,
              DEFAULT_CLICKHOUSE_SETTINGS,
              { compression: { request: true } },
            )
          }
          insertClient = compressedClient
        }
        const result = await insertClient.insert({
          table: params.table,
          values: params.values,
          format: 'JSONEachRow',
        })
        logProfiling(profiler, `INSERT INTO ${params.table}`, result.query_id, result.summary)
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
          query: `SELECT read_rows, read_bytes, written_rows, written_bytes, elapsed FROM clusterAllReplicas('cluster', system.processes) WHERE user = currentUser() AND query_id = {qid:String} SETTINGS skip_unavailable_shards = 1`,
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
FROM clusterAllReplicas('cluster', system.query_log)
WHERE user = currentUser()
  AND query_id = {qid:String}
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
      await Promise.all([client.close(), fireAndForgetClient.close(), compressedClient?.close()])
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
      const columns = await this.query<SystemColumnRow>(
        `SELECT database, table, name, type, default_kind, default_expression, comment, position, compression_codec
FROM system.columns
WHERE database IN (${quotedDatabases})`
      )
      const indexes = await this.query<SystemSkippingIndexRow>(
        `SELECT database, table, name, expr, type, granularity
FROM system.data_skipping_indices
WHERE database IN (${quotedDatabases})`
      )

      return buildIntrospectedTables(tables, columns, indexes)
    },
  }
}

export function createClickHouseExecutor(config: ClickHouseConfig): ClickHouseExecutor {
  // Default executor is session-bound so DDL-heavy workflows run through a
  // single ClickHouse HTTP session. Do not issue concurrent queries through it.
  const sessionId = crypto.randomUUID()
  return createExecutorWithClient(
    config,
    createSessionClickHouseClient(config, DEFAULT_CLICKHOUSE_SETTINGS, sessionId),
    {
      createCompressedClient: () => createSessionClickHouseClient(
        config,
        DEFAULT_CLICKHOUSE_SETTINGS,
        sessionId,
        { compression: { request: true } },
      ),
    },
  )
}

export function createStatelessClickHouseExecutor(config: ClickHouseConfig): ClickHouseExecutor {
  return createExecutorWithClient(
    config,
    createStatelessClickHouseClient(config),
    {
      createCompressedClient: () => createStatelessClickHouseClient(
        config,
        DEFAULT_CLICKHOUSE_SETTINGS,
        { compression: { request: true } },
      ),
    },
  )
}
