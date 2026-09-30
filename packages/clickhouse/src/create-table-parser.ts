import {
  findTopLevelSQLPattern,
  normalizeProjectionIndex,
  normalizeSQLFragment,
  splitTopLevelComma,
  unquoteIdentifiers,
} from '@chkit/core'

type ProjectionDefinitionShape =
  | { name: string; query: string }
  | { name: string; index: string; type: string }

function parseClauseFromCreateTableQuery(
  createTableQuery: string | undefined,
  clausePattern: RegExp,
  stopPattern: RegExp,
  preserveWhitespace = false
): string | undefined {
  if (!createTableQuery) return undefined
  // Table-level clauses (ENGINE, ORDER BY, PRIMARY KEY, ...) only appear after
  // the column list. Searching the whole query would match a keyword inside the
  // body — e.g. the `ORDER BY` of a projection's SELECT — and swallow the real
  // clause plus everything up to the next stop keyword (issue #190).
  const options = extractTableOptions(createTableQuery)
  const start = findTopLevelSQLPattern(options, clausePattern)
  if (!start) return undefined
  const afterClause = options.slice(start.index + start.length)
  const stop = findTopLevelSQLPattern(afterClause, stopPattern)
  const raw = (stop ? afterClause.slice(0, stop.index) : afterClause).trim()
  if (!raw) return undefined
  return preserveWhitespace ? raw : normalizeSQLFragment(raw)
}

/**
 * Positions of the parens that open and close the column list — the close being
 * the one right before the table-level `ENGINE =`. Returns undefined when there
 * is no balanced column list (e.g. a view, or a query we can't parse). Quoted
 * strings and identifiers are skipped, so parens or commas inside a quoted
 * table or column name never count.
 */
function findColumnListBounds(
  createTableQuery: string
): { open: number; close: number } | undefined {
  let depth = 0
  let openIndex = -1
  let quote: string | undefined
  for (let i = 0; i < createTableQuery.length; i += 1) {
    const char = createTableQuery[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) {
        if (createTableQuery[i + 1] === quote) i += 1
        else quote = undefined
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(') {
      if (depth === 0) openIndex = i
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0) {
        return /^\s*ENGINE\s*=/i.test(createTableQuery.slice(i + 1))
          ? { open: openIndex, close: i }
          : undefined
      }
    }
  }

  return undefined
}

function extractCreateTableBody(createTableQuery: string | undefined): string | undefined {
  if (!createTableQuery) return undefined
  const bounds = findColumnListBounds(createTableQuery)
  if (!bounds) return undefined
  const body = createTableQuery.slice(bounds.open + 1, bounds.close).trim()
  return body.length > 0 ? body : undefined
}

/**
 * Everything after the column list: `ENGINE = ... PARTITION BY ... ORDER BY ...`.
 * This is where table-level clauses live. Falls back to the whole query when the
 * column list can't be located, preserving behaviour for unparseable inputs.
 */
function extractTableOptions(createTableQuery: string): string {
  const bounds = findColumnListBounds(createTableQuery)
  return bounds ? createTableQuery.slice(bounds.close + 1) : createTableQuery
}

export function parseSettingsFromCreateTableQuery(createTableQuery: string | undefined): Record<string, string> {
  if (!createTableQuery) return {}
  const options = extractTableOptions(createTableQuery)
  const start = findTopLevelSQLPattern(options, /\bSETTINGS\b/i)
  if (!start) return {}
  const tail = options.slice(start.index + start.length)
  const stop = findTopLevelSQLPattern(tail, /\bCOMMENT\b|;/i)
  const rawSettings = (stop ? tail.slice(0, stop.index) : tail).trim()
  if (!rawSettings) return {}
  const items = splitTopLevelComma(rawSettings)
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
  const ttlMatch = extractTableOptions(createTableQuery).match(/\bTTL\b([\s\S]*?)(?:\bSETTINGS\b|;|$)/i)
  const raw = ttlMatch?.[1]?.trim()
  if (!raw) return undefined
  return normalizeSQLFragment(raw)
}

export function parseEngineFromCreateTableQuery(createTableQuery: string | undefined): string | undefined {
  return parseClauseFromCreateTableQuery(
    createTableQuery,
    /\bENGINE\s*=\s*/i,
    /\bPRIMARY\s+KEY\b|\bORDER\s+BY\b|\bPARTITION\s+BY\b|\bUNIQUE\s+KEY\b|\bSAMPLE\s+BY\b|\bTTL\b|\bSETTINGS\b|\bCOMMENT\b|;|$/i,
    true
  )
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

export function parseProjectionsFromCreateTableQuery(
  createTableQuery: string | undefined
): ProjectionDefinitionShape[] {
  const body = extractCreateTableBody(createTableQuery)
  if (!body) return []
  const parts = splitTopLevelComma(body)
  const projections: ProjectionDefinitionShape[] = []
  for (const part of parts) {
    // Index-only projections have no SELECT body, so they must be matched
    // before the parenthesized SELECT form.
    const indexMatch = part.match(
      /^\s*PROJECTION\s+(`(?:[^`\\]|\\.|``)+`|[A-Za-z_][A-Za-z0-9_]*)\s+INDEX\s+([\s\S]+?)\s+TYPE\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i
    )
    if (indexMatch) {
      const name = unquoteIdentifiers(indexMatch[1] ?? '').trim()
      const index = normalizeProjectionIndex(indexMatch[2] ?? '')
      const type = (indexMatch[3] ?? '').trim()
      if (!name || !index || !type) continue
      projections.push({ name, index, type })
      continue
    }

    const match = part.match(
      /^\s*PROJECTION\s+(`(?:[^`\\]|\\.|``)+`|[A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/i
    )
    if (!match) continue
    const name = unquoteIdentifiers(match[1] ?? '').trim()
    const query = normalizeSQLFragment((match[2] ?? '').trim())
    if (!name || !query) continue
    projections.push({ name, query })
  }
  return projections
}
