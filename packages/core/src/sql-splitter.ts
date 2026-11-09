import {
  isTrivia,
  readBlockComment,
  readHeredoc,
  readQuoted,
  sqlTokens,
  tokenizeSQL,
  type SQLToken,
} from './sql-lexer.js'

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  const lexedEnd = lexedEndAt(sql)

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? ''

    const end = quotedEnd(sql, i, lexedEnd)
    if (end !== undefined) {
      current += sql.slice(i, end)
      i = end - 1
      continue
    }

    if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed.length > 0) statements.push(`${trimmed};`)
      current = ''
      continue
    }

    current += ch
  }

  const tail = current.trim()
  if (tail.length > 0) statements.push(`${tail};`)
  return statements
}

export function extractExecutableStatements(sql: string): string[] {
  // Strip single-line comments (--) while respecting quoted strings.
  // We can't use a naive line-based filter because `--` inside string
  // literals must be preserved.
  let stripped = ''
  const lexedEnd = lexedEndAt(sql)

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? ''
    const next = sql[i + 1] ?? ''

    if (ch === '-' && next === '-') {
      // The comment runs to the end of the line; the newline stays.
      const newline = sql.indexOf('\n', i)
      if (newline === -1) break
      i = newline - 1
      continue
    }

    const end = quotedEnd(sql, i, lexedEnd)
    if (end !== undefined) {
      stripped += sql.slice(i, end)
      i = end - 1
      continue
    }

    stripped += ch
  }

  const statements = splitSqlStatements(stripped)
  // A statement made only of comments is not executable: ClickHouse rejects it
  // as "Empty query" (for example a block comment after the last statement).
  const executable = statements.filter(hasExecutableContent)
  if (executable.length === statements.length) return statements
  // The splitter does not know `#` and `//` line comments (#197). When one of
  // them holds a `;`, the splitter cut that comment line in two; keeping the
  // comment-only piece makes ClickHouse reject the file instead of running the
  // commented-out text after the `;`.
  if (tokenizeSQL(stripped).some(isLineCommentWithSemicolon)) return statements
  return executable
}

// Where the ClickHouse lexer reads a heredoc, a block comment (they nest) or a
// backtick-quoted name (with backslash escapes), the offset of its first
// character maps to its end. The scanner takes these ends only where it is at
// such a token itself; inside a `//` or `#` comment, which it does not know
// (#197), it keeps its own reading, so statements end where they always did.
// The input is lexed once, only as far as an offset the scanner asks about, and
// only when a token there could end elsewhere than the scanner reads it.
function lexedEndAt(sql: string): (i: number) => number | undefined {
  const tokens = sqlTokens(sql)
  const ends = new Map<number, number>()
  let lexedTo = 0
  return (i) => {
    while (lexedTo <= i) {
      const next = tokens.next()
      if (next.done) break
      const token = next.value
      const first = token.text[0]
      if (
        token.kind === 'block_comment' ||
        (token.kind === 'string' && first === '$') ||
        (token.kind === 'quoted_identifier' && first === '`')
      ) {
        ends.set(token.start, token.end)
      }
      lexedTo = token.end
    }
    return ends.get(i)
  }
}

// The end of the string, quoted identifier, block comment or heredoc that
// starts at `i`, or undefined when none starts there: a `;` or `--` inside one
// is text. An unclosed quote or block comment runs to the end of the input.
function quotedEnd(sql: string, i: number, lexedEnd: (i: number) => number | undefined): number | undefined {
  const ch = sql[i] ?? ''
  if (ch === '/' && sql[i + 1] === '*') {
    const end = closeEnd(sql, i + 2, '*/')
    return readBlockComment(sql, i).end === end ? end : (lexedEnd(i) ?? end)
  }
  if (ch === '`') {
    const end = closeEnd(sql, i + 1, '`')
    return readQuoted(sql, i, ch).end === end ? end : (lexedEnd(i) ?? end)
  }
  if (ch === "'" || ch === '"') return quoteEnd(sql, i, ch)
  // Only a heredoc ClickHouse reads: an unclosed `$tag$`, or a `$` inside a name.
  if (ch === '$') return readHeredoc(sql, i) === undefined ? undefined : lexedEnd(i)
  return undefined
}

function closeEnd(sql: string, from: number, close: string): number {
  const at = sql.indexOf(close, from)
  return at === -1 ? sql.length : at + close.length
}

// A backslash escapes the next character. A doubled quote ends one quoted part
// and starts the next, which ends where the escaped quote would.
function quoteEnd(sql: string, i: number, quote: string): number {
  for (let j = i + 1; j < sql.length; j += 1) {
    const ch = sql[j]
    if (ch === '\\' && j + 1 < sql.length) {
      j += 1
      continue
    }
    if (ch === quote) return j + 1
  }
  return sql.length
}

// True unless every token is whitespace or a terminated comment (`/* */`,
// nested or not, `# `, `#!`, `//`; `--` comments are already stripped). An
// unterminated comment counts as content, so ClickHouse reports it.
function hasExecutableContent(statement: string): boolean {
  // Only a statement that starts like a comment can be made only of comments.
  if (!/^[-/#]/.test(statement)) return true
  // The splitter appended the `;`; a trailing line comment would swallow it.
  const body = statement.endsWith(';') ? statement.slice(0, -1) : statement
  return tokenizeSQL(body).some((token) => !isTrivia(token) || !token.terminated)
}

function isLineCommentWithSemicolon(token: SQLToken): boolean {
  return token.kind === 'line_comment' && token.text.includes(';')
}
