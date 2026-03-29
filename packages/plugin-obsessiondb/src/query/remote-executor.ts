import type { ClickHouseExecutor, QueryStatus, SchemaObjectRef } from '@chkit/clickhouse'
import {
  buildIntrospectedTables,
  inferSchemaKindFromEngine,
  type SystemColumnRow,
  type SystemSkippingIndexRow,
  type SystemTableRow,
} from '@chkit/clickhouse'
import type { Credentials } from '../auth/index.js'
import { createApiClient, type ApiClient } from '../client.js'

function throwIfError(
  res: Awaited<ReturnType<ApiClient['workbench']['query']['execute']>>,
): void {
  if (res.error) {
    throw new Error(res.error)
  }
}

export function createRemoteExecutor(deps: {
  credentials: Credentials
  serviceId: string
}): ClickHouseExecutor {
  const { credentials, serviceId } = deps
  const client = createApiClient(credentials)

  const executor: ClickHouseExecutor = {
    async command(sql) {
      const res = await client.workbench.query.execute({ serviceId, query: sql })
      throwIfError(res)
    },

    async query<T>(sql: string): Promise<T[]> {
      const res = await client.workbench.query.execute({ serviceId, query: sql })
      throwIfError(res)
      return res.data as T[]
    },

    async insert<T extends Record<string, unknown>>(params: { table: string; values: T[] }) {
      if (params.values.length === 0) return
      const columns = Object.keys(params.values[0]!)
      const rows = params.values
        .map(
          (row) =>
            `(${columns.map((col) => {
              const val = row[col]
              if (val === null || val === undefined) return 'NULL'
              if (typeof val === 'number') return String(val)
              return `'${String(val).replace(/'/g, "\\'")}'`
            }).join(', ')})`,
        )
        .join(', ')
      await executor.command(`INSERT INTO ${params.table} (${columns.join(', ')}) VALUES ${rows}`)
    },

    async submit(sql, queryId?) {
      const res = await client.workbench.query.execute({
        serviceId,
        query: sql,
        settings: queryId ? { query_id: queryId } : undefined,
      })
      throwIfError(res)
      return queryId ?? 'submitted'
    },

    async queryStatus(queryId, options?) {
      const afterFilter = options?.afterTime
        ? `AND event_time >= '${options.afterTime}'`
        : ''

      const running = await executor.query<{ query_id: string }>(
        `SELECT query_id FROM system.processes WHERE query_id = '${queryId}' LIMIT 1`,
      )
      if (running.length > 0) return { status: 'running' as const }

      const log = await executor.query<{
        type: string
        written_rows: string
        written_bytes: string
        query_duration_ms: string
        exception: string
      }>(
        `SELECT type, written_rows, written_bytes, query_duration_ms, exception
FROM system.query_log
WHERE query_id = '${queryId}'
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  ${afterFilter}
ORDER BY event_time DESC
LIMIT 1`,
      )

      if (log.length === 0) return { status: 'unknown' as const }
      const row = log[0]!

      if (row.type === 'QueryFinish') {
        return {
          status: 'finished' as const,
          writtenRows: Number(row.written_rows),
          writtenBytes: Number(row.written_bytes),
          durationMs: Number(row.query_duration_ms),
        }
      }

      return {
        status: 'failed' as const,
        durationMs: Number(row.query_duration_ms),
        error: row.exception,
      } satisfies QueryStatus
    },

    async listSchemaObjects() {
      const rows = await executor.query<{ database: string; name: string; engine: string }>(
        `SELECT database, name, engine
FROM system.tables
WHERE is_temporary = 0
  AND database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
  AND name NOT LIKE '_chkit_%'`,
      )

      const out: SchemaObjectRef[] = []
      for (const row of rows) {
        const kind = inferSchemaKindFromEngine(row.engine)
        if (!kind) continue
        out.push({ kind, database: row.database, name: row.name })
      }
      return out
    },

    async listTableDetails(databases) {
      if (databases.length === 0) return []
      const quoted = databases.map((db) => `'${db.replace(/'/g, "''")}'`).join(', ')

      const [tables, columns, indexes] = await Promise.all([
        executor.query<SystemTableRow>(
          `SELECT database, name, engine, create_table_query FROM system.tables WHERE is_temporary = 0 AND database IN (${quoted})`,
        ),
        executor.query<SystemColumnRow>(
          `SELECT database, \`table\`, name, type, default_kind, default_expression, comment, position FROM system.columns WHERE database IN (${quoted})`,
        ),
        executor.query<SystemSkippingIndexRow>(
          `SELECT database, \`table\`, name, expr, type, granularity FROM system.data_skipping_indices WHERE database IN (${quoted})`,
        ),
      ])

      return buildIntrospectedTables(tables, columns, indexes)
    },

    async close() {},
  }

  return executor
}
