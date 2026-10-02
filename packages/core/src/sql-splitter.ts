import { isTrivia, tokenizeSQL, type SQLToken } from './sql-lexer.js'

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let inBacktick = false
  let inBlockComment = false

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? ''
    const next = sql[i + 1] ?? ''

    if (inBlockComment) {
      current += ch
      if (ch === '*' && next === '/') {
        current += next
        i += 1
        inBlockComment = false
      }
      continue
    }

    if (inSingleQuote) {
      current += ch
      if (ch === '\\' && next) {
        current += next
        i += 1
        continue
      }
      if (ch === "'" && next === "'") {
        current += next
        i += 1
        continue
      }
      if (ch === "'") {
        inSingleQuote = false
      }
      continue
    }

    if (inDoubleQuote) {
      current += ch
      if (ch === '\\' && next) {
        current += next
        i += 1
        continue
      }
      if (ch === '"') {
        inDoubleQuote = false
      }
      continue
    }

    if (inBacktick) {
      current += ch
      if (ch === '`') {
        inBacktick = false
      }
      continue
    }

    if (ch === '/' && next === '*') {
      current += ch
      current += next
      i += 1
      inBlockComment = true
      continue
    }

    if (ch === "'") {
      current += ch
      inSingleQuote = true
      continue
    }

    if (ch === '"') {
      current += ch
      inDoubleQuote = true
      continue
    }

    if (ch === '`') {
      current += ch
      inBacktick = true
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
  let inSingleQuote = false
  let inDoubleQuote = false
  let inBacktick = false
  let inBlockComment = false
  let inLineComment = false

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? ''
    const next = sql[i + 1] ?? ''

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        stripped += ch
      }
      continue
    }

    if (inBlockComment) {
      stripped += ch
      if (ch === '*' && next === '/') {
        stripped += next
        i += 1
        inBlockComment = false
      }
      continue
    }

    if (inSingleQuote) {
      stripped += ch
      if (ch === '\\' && next) {
        stripped += next
        i += 1
        continue
      }
      if (ch === "'" && next === "'") {
        stripped += next
        i += 1
        continue
      }
      if (ch === "'") {
        inSingleQuote = false
      }
      continue
    }

    if (inDoubleQuote) {
      stripped += ch
      if (ch === '\\' && next) {
        stripped += next
        i += 1
        continue
      }
      if (ch === '"') {
        inDoubleQuote = false
      }
      continue
    }

    if (inBacktick) {
      stripped += ch
      if (ch === '`') {
        inBacktick = false
      }
      continue
    }

    if (ch === '-' && next === '-') {
      inLineComment = true
      i += 1
      continue
    }

    if (ch === '/' && next === '*') {
      stripped += ch
      stripped += next
      i += 1
      inBlockComment = true
      continue
    }

    if (ch === "'") {
      stripped += ch
      inSingleQuote = true
      continue
    }

    if (ch === '"') {
      stripped += ch
      inDoubleQuote = true
      continue
    }

    if (ch === '`') {
      stripped += ch
      inBacktick = true
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
