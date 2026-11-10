import { createHash } from 'node:crypto'

import { isTrivia, tokenizeSQL, type SQLToken } from './sql-lexer.js'

/**
 * The SQL of a statement, comments and whitespace aside: what ClickHouse
 * parses is the same for two statements with the same fingerprint. Any other
 * change (a name, a literal, a keyword's case, a token added or removed)
 * changes it. Trailing `;` do not count. The inline data of an
 * `INSERT … FORMAT <name>` statement is not SQL: everything after the format
 * name counts byte for byte.
 *
 * The journal records it per statement, so a resumed or retried migration can
 * tell that a statement it skips as completed is the one that ran (#599). The
 * `v1:` prefix names this encoding; chkit-py computes the same value.
 */
export function statementFingerprint(statement: string): string {
  const tokens = tokenizeSQL(statement).filter((token) => !isTrivia(token))
  const dataStart = inlineDataStart(tokens)
  const sql = (dataStart === undefined ? tokens : tokens.filter((token) => token.end <= dataStart)).map(
    (token) => token.text,
  )
  if (dataStart === undefined) {
    while (sql.at(-1) === ';') sql.pop()
  }
  const hash = createHash('sha256')
  // Each token is length-prefixed, so token boundaries are part of the hash; the
  // inline data starts with `#`, which no length prefix does.
  for (const text of sql) hash.update(`${Buffer.byteLength(text, 'utf8')}:${text}`, 'utf8')
  if (dataStart !== undefined) {
    const data = statement.slice(dataStart)
    hash.update(`#${Buffer.byteLength(data, 'utf8')}:${data}`, 'utf8')
  }
  return `v1:${hash.digest('hex')}`
}

/**
 * Where the inline data of `INSERT … FORMAT <name>` starts: right after the
 * format name. The clause is a `FORMAT` outside parentheses, followed by a
 * name, that is neither the table name nor after the `SELECT`, `WITH` or
 * `VALUES` that starts the rows another way. Undefined for any other
 * statement. A misreading only makes the fingerprint stricter.
 */
function inlineDataStart(tokens: readonly SQLToken[]): number | undefined {
  if (tokens[0]?.text.toUpperCase() !== 'INSERT') return undefined
  let depth = 0
  for (const [index, token] of tokens.entries()) {
    if (token.text === '(') depth += 1
    else if (token.text === ')') depth -= 1
    if (depth !== 0 || token.kind !== 'identifier') continue
    const word = token.text.toUpperCase()
    if (ROWS_START.has(word)) return undefined
    const previous = tokens[index - 1]?.text.toUpperCase()
    const name = tokens[index + 1]
    if (word === 'FORMAT' && previous !== 'INTO' && previous !== 'TABLE' && name?.kind === 'identifier') {
      return name.end
    }
  }
  return undefined
}

const ROWS_START = new Set(['SELECT', 'WITH', 'VALUES'])
