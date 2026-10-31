import { identifierName, isTrivia, tokenizeSQL } from '@chkit/core'

import type { ClickHouseExecutor } from './index.js'

export interface IntrospectedView {
  kind: 'view' | 'materialized_view'
  database: string
  name: string
  /** The SELECT as ClickHouse stores it (`system.tables.as_select`). */
  query: string
  /** The `TO` target of a materialized view, when it has one. */
  to?: { database: string; name: string }
}

interface SystemViewRow {
  database: string
  name: string
  engine: string
  as_select: string
  create_table_query: string
}

/**
 * The views and materialized views in `databases`, with the query ClickHouse
 * stores for each. ClickHouse qualifies unqualified table names in that query
 * with the database the view was created from, so `FROM events` comes back as
 * `FROM analytics.events`.
 */
export async function listViewDetails(
  executor: Pick<ClickHouseExecutor, 'query'>,
  databases: string[]
): Promise<IntrospectedView[]> {
  if (databases.length === 0) return []
  const quotedDatabases = databases.map((db) => `'${db.replace(/'/g, "''")}'`).join(', ')
  const rows = await executor.query<SystemViewRow>(
    `SELECT database, name, engine, as_select, create_table_query
FROM system.tables
WHERE is_temporary = 0
  AND database IN (${quotedDatabases})
  AND engine IN ('View', 'MaterializedView')`
  )
  return rows.map((row) => {
    if (row.engine === 'View') {
      return { kind: 'view', database: row.database, name: row.name, query: row.as_select }
    }
    const to = parseMaterializedViewTarget(row.create_table_query, row.database)
    return {
      kind: 'materialized_view',
      database: row.database,
      name: row.name,
      query: row.as_select,
      ...(to ? { to } : {}),
    }
  })
}

/**
 * The `TO [db.]name` of a `CREATE MATERIALIZED VIEW` statement: the first
 * top-level `TO` after the view name and before `AS`. A materialized view with
 * an inner table has none.
 */
export function parseMaterializedViewTarget(
  createQuery: string | undefined,
  fallbackDatabase: string
): { database: string; name: string } | undefined {
  if (!createQuery) return undefined
  const tokens = tokenizeSQL(createQuery).filter((token) => !isTrivia(token))
  const nameAt = (i: number): string | undefined => {
    const token = tokens[i]
    return token ? identifierName(token) : undefined
  }
  // Skip `CREATE MATERIALIZED VIEW <db>.<name>`.
  let i = tokens[4]?.text === '.' ? 6 : 4
  let depth = 0
  for (; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    if (token.text === '(') depth++
    else if (token.text === ')') depth--
    if (depth !== 0 || token.kind !== 'identifier') continue
    const keyword = token.text.toUpperCase()
    if (keyword === 'AS') return undefined
    if (keyword !== 'TO') continue
    const first = nameAt(i + 1)
    if (first === undefined) return undefined
    if (tokens[i + 2]?.text !== '.') return { database: fallbackDatabase, name: first }
    const second = nameAt(i + 3)
    return second === undefined ? undefined : { database: first, name: second }
  }
  return undefined
}
