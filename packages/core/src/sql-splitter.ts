import { isTrivia, readHeredoc, tokenizeSQL, type SQLToken } from './sql-lexer.js'

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  // Inside a `//`, `# ` or `#!` comment only the newline and `;` count: the
  // splitter still cuts at a `;` there (see extractExecutableStatements).
  let inLineComment = false

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? ''

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
    } else {
      const end = quotedEnd(sql, i)
      if (end !== undefined) {
        current += sql.slice(i, end)
        i = end - 1
        continue
      }
      inLineComment = startsLineComment(sql, i)
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
  let inLineComment = false

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

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      stripped += ch
      continue
    }

    const end = quotedEnd(sql, i)
    if (end !== undefined) {
      stripped += sql.slice(i, end)
      i = end - 1
      continue
    }

    inLineComment = startsLineComment(sql, i)
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

const NAME_CHAR = /[A-Za-z0-9_$]/

// `//x`, `# x` and `#!x` start a line comment, as in ClickHouse (`#x` does not).
// A quote or `$` inside one starts nothing.
function startsLineComment(sql: string, i: number): boolean {
  const ch = sql[i]
  const next = sql[i + 1]
  return (ch === '/' && next === '/') || (ch === '#' && (next === ' ' || next === '!'))
}

// The end of the string, quoted identifier, block comment or heredoc that
// starts at `i`, or undefined when none starts there: a `;` or `--` inside one
// is text. An unclosed quote or block comment runs to the end of the input; an
// unclosed `$tag$` is not a heredoc, as in ClickHouse.
function quotedEnd(sql: string, i: number): number | undefined {
  const ch = sql[i] ?? ''
  if (ch === '/' && sql[i + 1] === '*') return blockCommentEnd(sql, i)
  if (ch === "'" || ch === '"' || ch === '`') return quoteEnd(sql, i, ch)
  // `a$$b` is one name: a heredoc starts only where a name does not go on.
  if (ch === '$' && !NAME_CHAR.test(sql[i - 1] ?? '')) return readHeredoc(sql, i)
  return undefined
}

// ClickHouse block comments nest: `/* a /* b */ c */` is one comment.
function blockCommentEnd(sql: string, i: number): number {
  let depth = 0
  let j = i
  while (j < sql.length) {
    if (sql.startsWith('/*', j)) {
      depth += 1
      j += 2
    } else if (sql.startsWith('*/', j)) {
      depth -= 1
      j += 2
      if (depth === 0) return j
    } else {
      j += 1
    }
  }
  return sql.length
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
