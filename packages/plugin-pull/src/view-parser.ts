import { inferSchemaKindFromEngine, type IntrospectedTable } from '@chkit/clickhouse'
import type { MaterializedViewDefinition, ViewDefinition } from '@chkit/core'

export interface SystemTableRow {
  database: string
  name: string
  engine: string
  create_table_query?: string
}

export type IntrospectedObject =
  | ({ kind: 'table' } & IntrospectedTable)
  | ({ kind: 'view' } & Pick<ViewDefinition, 'database' | 'name' | 'as'>)
  | ({ kind: 'materialized_view' } & Pick<MaterializedViewDefinition, 'database' | 'name' | 'to' | 'as'>)
  | IntrospectedTable

export function mapSystemTableRowToDefinition(
  row: SystemTableRow
): Exclude<IntrospectedObject, IntrospectedTable> | null {
  const kind = inferSchemaKindFromEngine(row.engine)
  if (kind === 'view') {
    const as = parseAsClause(row.create_table_query)
    if (!as) return null
    return { kind: 'view', database: row.database, name: row.name, as }
  }
  if (kind === 'materialized_view') {
    const as = parseAsClause(row.create_table_query)
    const to = parseToClause(row.create_table_query, row.database)
    if (!as || !to) return null
    return { kind: 'materialized_view', database: row.database, name: row.name, to, as }
  }
  return null
}

export function parseAsClause(query: string | undefined): string | null {
  if (!query) return null
  const match = /\bAS\b([\s\S]*)$/i.exec(query)
  if (!match?.[1]) return null
  const asClause = match[1].trim().replace(/;$/, '').trim()
  return asClause.length > 0 ? asClause : null
}

export function parseToClause(
  query: string | undefined,
  fallbackDatabase: string
): { database: string; name: string } | null {
  if (!query) return null
  const identifier = /(?:^|\s)TO\s+((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_]+)(?:\.(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_]+))?)/i.exec(
    query
  )?.[1]
  if (!identifier) return null
  const parts = identifier.split('.').map((part) => part.replace(/^[`"]|[`"]$/g, '').trim())
  if (parts.length === 1) {
    const name = parts[0] ?? ''
    if (name.length === 0) return null
    return { database: fallbackDatabase, name }
  }
  if (parts.length === 2) {
    const database = parts[0] ?? fallbackDatabase
    const name = parts[1] ?? ''
    if (database.length === 0 || name.length === 0) return null
    return { database, name }
  }
  return null
}
