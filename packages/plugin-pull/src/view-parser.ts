import { inferSchemaKindFromEngine, type IntrospectedTable } from '@chkit/clickhouse'
import type {
  MaterializedViewDefinition,
  MaterializedViewRefresh,
  ViewDefinition,
} from '@chkit/core'

export interface SystemTableRow {
  database: string
  name: string
  engine: string
  create_table_query?: string
}

export type IntrospectedObject =
  | ({ kind: 'table' } & IntrospectedTable)
  | ({ kind: 'view' } & Pick<ViewDefinition, 'database' | 'name' | 'as'>)
  | ({ kind: 'materialized_view' } & Pick<
      MaterializedViewDefinition,
      'database' | 'name' | 'to' | 'as' | 'refresh'
    >)
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
    const refresh = parseRefreshClause(row.create_table_query)
    const base = { kind: 'materialized_view' as const, database: row.database, name: row.name, to, as }
    return refresh ? { ...base, refresh } : base
  }
  return null
}

/**
 * Strips `DEFINER = ... SQL SECURITY ...` clauses that managed ClickHouse
 * environments (e.g. ObsessionDB) auto-inject into MV DDL. These are orthogonal
 * to schema semantics and absent from user input.
 */
function stripDefinerClauses(query: string): string {
  return query
    .replace(/\bDEFINER\s*=\s*(?:CURRENT_USER|`[^`]+`|"[^"]+"|[A-Za-z0-9_]+)/gi, '')
    .replace(/\bSQL\s+SECURITY\s+(?:DEFINER|INVOKER|NONE)/gi, '')
}

export function parseAsClause(query: string | undefined): string | null {
  if (!query) return null
  const cleaned = stripDefinerClauses(query)
  const match = /\bAS\b([\s\S]*)$/i.exec(cleaned)
  if (!match?.[1]) return null
  const asClause = match[1].trim().replace(/;$/, '').trim()
  return asClause.length > 0 ? asClause : null
}

const INTERVAL_TOKEN = '\\d+\\s+(?:SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?(?:\\s+\\d+\\s+(?:SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?)*'

function normalizeInterval(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b(second|minute|hour|day|week|month|year)s?\b/gi, (unit) =>
      unit.toUpperCase().replace(/S$/, '')
    )
}

function parseRefreshSettings(segment: string): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  // Split on top-level commas (no parentheses nesting expected in SETTINGS).
  for (const entry of segment.split(',')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(entry)
    if (!match?.[1] || match[2] === undefined) continue
    const key = match[1]
    const raw = match[2].trim()
    if (/^'.*'$/.test(raw)) {
      out[key] = raw.slice(1, -1).replace(/''/g, "'")
      continue
    }
    const asNumber = Number(raw)
    if (!Number.isNaN(asNumber) && raw !== '') {
      out[key] = asNumber
      continue
    }
    out[key] = raw
  }
  return out
}

function parseDependsOn(segment: string): Array<{ database: string; name: string }> {
  const out: Array<{ database: string; name: string }> = []
  for (const entry of segment.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const parts = trimmed.split('.').map((part) => part.replace(/^[`"]|[`"]$/g, '').trim())
    if (parts.length === 1 && parts[0]) {
      out.push({ database: 'default', name: parts[0] })
    } else if (parts.length === 2 && parts[0] && parts[1]) {
      out.push({ database: parts[0], name: parts[1] })
    }
  }
  return out
}

/**
 * Parses the REFRESH block from a CREATE MATERIALIZED VIEW statement.
 * Returns null when the query contains no REFRESH clause (regular MV).
 *
 * Handles, in any order:
 *   REFRESH EVERY|AFTER <interval>
 *   OFFSET <interval>
 *   RANDOMIZE FOR <interval>
 *   DEPENDS ON <list>
 *   SETTINGS <kv-list>
 *   APPEND
 *   EMPTY
 *
 * Strips DEFINER / SQL SECURITY auto-injected by managed ClickHouse environments before parsing.
 */
export function parseRefreshClause(
  query: string | undefined
): MaterializedViewRefresh | null {
  if (!query) return null
  const cleaned = stripDefinerClauses(query)
  const refreshMatch = new RegExp(
    `\\bREFRESH\\s+(EVERY|AFTER)\\s+(${INTERVAL_TOKEN})`,
    'i'
  ).exec(cleaned)
  if (!refreshMatch) return null

  const refresh: MaterializedViewRefresh = {}
  if (refreshMatch[1]?.toUpperCase() === 'EVERY') {
    refresh.every = normalizeInterval(refreshMatch[2] ?? '')
  } else {
    refresh.after = normalizeInterval(refreshMatch[2] ?? '')
  }

  const offsetMatch = new RegExp(`\\bOFFSET\\s+(${INTERVAL_TOKEN})`, 'i').exec(cleaned)
  if (offsetMatch?.[1]) refresh.offset = normalizeInterval(offsetMatch[1])

  const randomizeMatch = new RegExp(`\\bRANDOMIZE\\s+FOR\\s+(${INTERVAL_TOKEN})`, 'i').exec(cleaned)
  if (randomizeMatch?.[1]) refresh.randomize = normalizeInterval(randomizeMatch[1])

  // DEPENDS ON runs until the next known keyword or end of refresh block.
  const dependsMatch =
    /\bDEPENDS\s+ON\s+([\s\S]*?)(?=\bSETTINGS\b|\bAPPEND\b|\bTO\b|\bEMPTY\b|\bAS\b|$)/i.exec(cleaned)
  if (dependsMatch?.[1]) {
    const deps = parseDependsOn(dependsMatch[1])
    if (deps.length > 0) refresh.dependsOn = deps
  }

  const settingsMatch =
    /\bSETTINGS\s+([\s\S]*?)(?=\bAPPEND\b|\bTO\b|\bEMPTY\b|\bAS\b|$)/i.exec(cleaned)
  if (settingsMatch?.[1]) {
    const settings = parseRefreshSettings(settingsMatch[1])
    if (Object.keys(settings).length > 0) refresh.settings = settings
  }

  // APPEND / EMPTY must appear between the TO/SETTINGS area and AS.
  const afterRefresh = cleaned.slice(refreshMatch.index)
  const beforeAs = afterRefresh.split(/\bAS\b/i)[0] ?? ''
  if (/\bAPPEND\b/i.test(beforeAs)) refresh.append = true
  if (/\bEMPTY\b/i.test(beforeAs)) refresh.empty = true

  return refresh
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
