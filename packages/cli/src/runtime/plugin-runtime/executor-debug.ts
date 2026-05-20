import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { debug, isDebugEnabled } from '../debug.js'

function truncate(sql: string): string {
  return sql.length > 200 ? `${sql.slice(0, 200)}...` : sql
}

async function trace<T>(
  label: string,
  describeOk: ((result: T) => string) | null,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now()
  try {
    const result = await fn()
    const detail = describeOk ? ` — ${describeOk(result)}` : ''
    debug('clickhouse', `${label} OK${detail} (${Math.round(performance.now() - start)}ms)`)
    return result
  } catch (error) {
    debug(
      'clickhouse',
      `${label} FAILED (${Math.round(performance.now() - start)}ms)`,
      error instanceof Error ? error.message : error,
    )
    throw error
  }
}

export function wrapExecutorWithDebug(
  executor: ClickHouseExecutor,
): ClickHouseExecutor {
  if (!isDebugEnabled()) return executor
  const queryJson = executor.queryJson?.bind(executor)

  return {
    command(sql: string): Promise<void> {
      debug('clickhouse', `command: ${truncate(sql)}`)
      return trace('command', null, () => executor.command(sql))
    },
    query<T>(sql: string): Promise<T[]> {
      debug('clickhouse', `query: ${truncate(sql)}`)
      return trace('query', (rows) => `${rows.length} rows`, () => executor.query<T>(sql))
    },
    ...(queryJson
      ? {
          queryJson<T extends Record<string, unknown>>(sql: string) {
            debug('clickhouse', `queryJson: ${truncate(sql)}`)
            return trace(
              'queryJson',
              (payload) => `${payload.rows} rows`,
              () => queryJson<T>(sql),
            )
          },
        }
      : {}),
    insert<T extends Record<string, unknown>>(params: {
      table: string
      values: T[]
      compressed?: boolean
    }): Promise<void> {
      debug(
        'clickhouse',
        `insert into ${params.table} — ${params.values.length} rows`,
      )
      return trace('insert', null, () => executor.insert(params))
    },
    submit(sql: string, queryId?: string): Promise<string> {
      debug(
        'clickhouse',
        `submit${queryId ? ` (id: ${queryId})` : ''}: ${truncate(sql)}`,
      )
      return trace('submit', (id) => `id: ${id}`, () => executor.submit(sql, queryId))
    },
    queryStatus(queryId: string, options?: { afterTime?: string }) {
      debug('clickhouse', `queryStatus for ${queryId}`)
      return trace(
        'queryStatus',
        (status) => status.status,
        () => executor.queryStatus(queryId, options),
      )
    },
    listSchemaObjects() {
      debug('clickhouse', 'listSchemaObjects')
      return trace(
        'listSchemaObjects',
        (objects) => `${objects.length} objects`,
        () => executor.listSchemaObjects(),
      )
    },
    listTableDetails(databases: string[]) {
      debug('clickhouse', `listTableDetails for databases: [${databases.join(', ')}]`)
      return trace(
        'listTableDetails',
        (tables) => `${tables.length} tables`,
        () => executor.listTableDetails(databases),
      )
    },
    async close(): Promise<void> {
      debug('clickhouse', 'closing connections')
      await executor.close()
    },
  }
}
