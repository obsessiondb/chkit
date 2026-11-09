import { createHash } from 'node:crypto'

import { isTrivia, tokenizeSQL } from './sql-lexer.js'

/**
 * The SQL of a statement, comments and whitespace aside: what ClickHouse
 * parses is the same for two statements with the same fingerprint. Any other
 * change (a name, a literal, a keyword's case, a token added or removed)
 * changes it. Trailing `;` do not count.
 *
 * The journal records it per statement, so a resumed or retried migration can
 * tell that a statement it skips as completed is the one that ran (#599). The
 * `v1:` prefix names this encoding; chkit-py computes the same value.
 */
export function statementFingerprint(statement: string): string {
  const tokens = tokenizeSQL(statement)
    .filter((token) => !isTrivia(token))
    .map((token) => token.text)
  while (tokens.at(-1) === ';') tokens.pop()
  const hash = createHash('sha256')
  // Each token is length-prefixed, so token boundaries are part of the hash.
  for (const text of tokens) hash.update(`${Buffer.byteLength(text, 'utf8')}:${text}`, 'utf8')
  return `v1:${hash.digest('hex')}`
}
