import { normalizeProjectionIndex, normalizeSQLFragment, splitTopLevelComma } from '@chkit/core'

type ProjectionDefinitionShape =
  | { name: string; query: string }
  | { name: string; index: string; type: string }

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

export function parseSettingsFromCreateTableQuery(createTableQuery: string | undefined): Record<string, string> {
  if (!createTableQuery) return {}
  const settingsMatch = createTableQuery.match(/\bSETTINGS\b([\s\S]*?)(?:;|$)/i)
  if (!settingsMatch?.[1]) return {}
  const rawSettings = settingsMatch[1].trim()
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
  const ttlMatch = createTableQuery.match(/\bTTL\b([\s\S]*?)(?:\bSETTINGS\b|;|$)/i)
  const raw = ttlMatch?.[1]?.trim()
  if (!raw) return undefined
  return normalizeSQLFragment(raw)
}

export function parseEngineFromCreateTableQuery(createTableQuery: string | undefined): string | undefined {
  return parseClauseFromCreateTableQuery(
    createTableQuery,
    /\bENGINE\s*=\s*/i,
    /\bPRIMARY\s+KEY\b|\bORDER\s+BY\b|\bPARTITION\s+BY\b|\bUNIQUE\s+KEY\b|\bSAMPLE\s+BY\b|\bTTL\b|\bSETTINGS\b|;|$/i
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
      /^\s*PROJECTION\s+(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s+INDEX\s+([\s\S]+?)\s+TYPE\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i
    )
    if (indexMatch) {
      const name = (indexMatch[1] ?? indexMatch[2] ?? '').trim()
      const index = normalizeProjectionIndex(indexMatch[3] ?? '')
      const type = (indexMatch[4] ?? '').trim()
      if (!name || !index || !type) continue
      projections.push({ name, index, type })
      continue
    }

    const match = part.match(
      /^\s*PROJECTION\s+(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s*\(([\s\S]*)\)\s*$/i
    )
    if (!match) continue
    const name = (match[1] ?? match[2] ?? '').trim()
    const query = normalizeSQLFragment((match[3] ?? '').trim())
    if (!name || !query) continue
    projections.push({ name, query })
  }
  return projections
}
