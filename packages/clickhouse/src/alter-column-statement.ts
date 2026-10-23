import { identifierName, isTrivia, stringLiteralValue, tokenizeSQL, type SQLToken } from '@chkit/core'

/**
 * What a `MODIFY COLUMN` statement sets, in `system.columns` terms. A field is
 * set only when the statement sets it: ClickHouse keeps a column's default,
 * comment and codec when MODIFY COLUMN leaves them out.
 */
export interface ColumnIntent {
  /** `''` after `REMOVE DEFAULT` (or MATERIALIZED, ALIAS, EPHEMERAL). */
  defaultKind?: string
  /** The expression as written; the server formats it before it is compared. */
  defaultExpression?: string
  /** `EPHEMERAL` without an expression stores `defaultValueOfTypeName(<type>)`. */
  typeDefault?: boolean
  comment?: string
  /** `REMOVE CODEC`. A codec the statement sets is compared between replicas only. */
  codecRemoved?: boolean
}

const DEFAULT_KINDS = new Set(['DEFAULT', 'MATERIALIZED', 'ALIAS', 'EPHEMERAL'])
// Clauses that may follow a column's type or default expression.
const TRAILING_CLAUSES = new Set(['TTL', 'SETTINGS', 'FIRST', 'AFTER', 'STATISTICS', 'PRIMARY'])

/**
 * Reads what `ALTER TABLE ... MODIFY COLUMN <column> ...` sets. Returns an
 * empty intent when the statement is not a single MODIFY COLUMN of `column`
 * (hand-written or plugin-rewritten SQL), so the wait falls back to checking
 * that every replica agrees.
 */
export function parseModifyColumnIntent(statement: string, column: string): ColumnIntent {
  const tokens = significantTokens(statement)
  let i = findTopLevel(tokens, ['MODIFY', 'COLUMN'])
  if (i < 0) return {}
  if (word(tokens[i]) === 'IF' && word(tokens[i + 1]) === 'EXISTS') i += 2
  const name = tokens[i]
  if (!name || identifierName(name) !== column) return {}
  i += 1

  if (word(tokens[i]) === 'REMOVE') {
    const removed = word(tokens[i + 1])
    if (DEFAULT_KINDS.has(removed)) return { defaultKind: '' }
    if (removed === 'CODEC') return { codecRemoved: true }
    if (removed === 'COMMENT') return { comment: '' }
    return {}
  }

  const intent: ColumnIntent = {}
  i = skipToClause(tokens, i)
  const kind = word(tokens[i])
  if (DEFAULT_KINDS.has(kind)) {
    const start = i + 1
    i = skipToClause(tokens, start)
    const expression = tokens.slice(start, i)
    intent.defaultKind = kind
    if (expression.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: slice is non-empty
      intent.defaultExpression = statement.slice(expression[0]!.start, expression[expression.length - 1]!.end)
    } else if (kind === 'EPHEMERAL') {
      intent.typeDefault = true
    } else {
      return {}
    }
  }
  for (;;) {
    const clause = word(tokens[i])
    if (clause === 'COMMENT') {
      const value = tokens[i + 1] ? stringLiteralValue(tokens[i + 1] as SQLToken) : undefined
      if (value === undefined) return intent
      intent.comment = value
      i += 2
    } else if (clause === 'CODEC') {
      i = skipToClause(tokens, i + 1)
    } else {
      return intent
    }
  }
}

/**
 * Reads `ALTER TABLE ... RENAME COLUMN [IF EXISTS] <from> TO <to>`. Names may
 * contain ':', so an operation key cannot tell where `from` ends.
 */
export function parseRenameColumn(statement: string): { from: string; to: string } | undefined {
  const tokens = significantTokens(statement)
  let i = findTopLevel(tokens, ['RENAME', 'COLUMN'])
  if (i < 0) return undefined
  if (word(tokens[i]) === 'IF' && word(tokens[i + 1]) === 'EXISTS') i += 2
  const from = tokens[i] ? identifierName(tokens[i] as SQLToken) : undefined
  const to = tokens[i + 2] ? identifierName(tokens[i + 2] as SQLToken) : undefined
  if (from === undefined || to === undefined || word(tokens[i + 1]) !== 'TO') return undefined
  return { from, to }
}

function significantTokens(statement: string): SQLToken[] {
  return tokenizeSQL(statement).filter((token) => !isTrivia(token))
}

/** Index just past the first top-level occurrence of the keyword sequence. */
function findTopLevel(tokens: SQLToken[], keywords: string[]): number {
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    depth += nesting(tokens[i])
    if (depth === 0 && keywords.every((keyword, offset) => word(tokens[i + offset]) === keyword)) {
      return i + keywords.length
    }
  }
  return -1
}

/**
 * Index of the next top-level clause keyword at or after `from`: a default
 * kind, `COMMENT '<text>'`, `CODEC(...)`, a trailing clause, `,` or `;`.
 */
function skipToClause(tokens: SQLToken[], from: number): number {
  let depth = 0
  for (let i = from; i < tokens.length; i++) {
    if (depth === 0 && isClauseStart(tokens, i)) return i
    depth += nesting(tokens[i])
  }
  return tokens.length
}

function isClauseStart(tokens: SQLToken[], i: number): boolean {
  const token = tokens[i] as SQLToken
  if (token.text === ',' || token.text === ';') return true
  const keyword = word(token)
  if (DEFAULT_KINDS.has(keyword) || TRAILING_CLAUSES.has(keyword)) return true
  if (keyword === 'COMMENT') return tokens[i + 1]?.kind === 'string'
  if (keyword === 'CODEC') return tokens[i + 1]?.text === '('
  return false
}

function nesting(token: SQLToken | undefined): number {
  if (token?.kind !== 'punctuation') return 0
  if (token.text === '(' || token.text === '[') return 1
  if (token.text === ')' || token.text === ']') return -1
  return 0
}

function word(token: SQLToken | undefined): string {
  return token?.kind === 'identifier' ? token.text.toUpperCase() : ''
}
