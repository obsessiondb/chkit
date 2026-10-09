import { isPlainColumnReference } from './key-clause.js'
import { findQuoteEnd } from './sql-scan.js'

// ASCII control characters (incl. NUL). ClickHouse cannot round-trip them in a
// name reliably, and they are never intentional in a schema object name.
function hasControlCharacter(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Wraps a name in backticks, escaping backslashes and backticks so the name can
 * never terminate the quoted identifier early. Matches ClickHouse's own
 * formatting of quoted identifiers.
 */
export function quoteIdentifier(name: string): string {
  return `\`${name.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``
}

/**
 * Renders a database or object name. Plain identifiers stay bare so generated
 * SQL is unchanged for existing schemas; anything else is quoted and escaped.
 */
export function renderIdentifier(name: string): string {
  return isPlainColumnReference(name) ? name : quoteIdentifier(name)
}

export function renderQualifiedName(database: string, name: string): string {
  return `${renderIdentifier(database)}.${renderIdentifier(name)}`
}

/** Returns why a name cannot be used as a ClickHouse identifier, if it can't. */
export function describeInvalidIdentifier(name: string): string | undefined {
  if (name.length === 0) return 'is empty'
  if (hasControlCharacter(name)) return 'contains a control character'
  return undefined
}

/**
 * Replaces every backtick-quoted identifier in a SQL fragment with its raw,
 * unescaped name, leaving string literals untouched. Used to compare clauses
 * that ClickHouse re-renders with its own quoting (e.g. key clauses in drift).
 */
export function unquoteIdentifiers(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const char = sql[i]
    if (char === "'") {
      const end = findQuoteEnd(sql, i, "'")
      out += sql.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (char === '`') {
      const end = findQuoteEnd(sql, i, '`')
      out += unescapeQuoted(sql.slice(i + 1, end))
      i = end + 1
      continue
    }
    out += char
    i += 1
  }
  return out
}

export function unescapeQuoted(body: string, quote = '`'): string {
  return body.replace(new RegExp(`\\\\(.)|${quote}${quote}`, 'g'), (_match, escaped: string | undefined) => escaped ?? quote)
}
