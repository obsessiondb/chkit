import { isTrivia, sqlTokens, tokenizeSQL, type SQLToken } from './sql-lexer.js'

interface SplitOptions {
  /** Read `//`, `# ` and `#!` comments as ClickHouse does (#562). */
  lineComments: boolean
}

const CLICKHOUSE: SplitOptions = { lineComments: true }
const BEFORE_562: SplitOptions = { lineComments: false }

export function splitSqlStatements(sql: string): string[] {
  return split(sql, CLICKHOUSE).map((piece) => piece.text)
}

export function extractExecutableStatements(sql: string): string[] {
  return extract(sql, CLICKHOUSE).statements.map((piece) => piece.text)
}

/** An executable statement with the `--` comments that come before it (#831). */
export interface ExecutableStatementWithComments {
  /** The statement as `extractExecutableStatements` returns it. */
  sql: string
  /**
   * The `--` comments on lines of their own after the previous executable
   * statement and before this one ends, trimmed, in file order. Each block
   * holds the comments that only whitespace separates; a comment after SQL
   * on its line is left out.
   */
  commentBlocks: string[][]
  /**
   * The blocks of `commentBlocks` that only whitespace separates from the
   * statement's first character (#888): a marker among them comes right
   * before the statement, with no SQL or other comment in between.
   */
  leadingBlocks: string[][]
}

/**
 * `extractExecutableStatements`, with the `--` comments that belong to each
 * statement: those between the end of the executable statement before it and
 * its own end. A comment after the last statement belongs to none. Like the
 * split, it reads a `--` inside a string, a quoted name, a block comment, a
 * heredoc or a `//`, `# ` or `#!` comment as text.
 */
export function extractExecutableStatementsWithComments(sql: string): ExecutableStatementWithComments[] {
  const { statements, comments, stripped } = extract(sql, CLICKHOUSE)
  const result: ExecutableStatementWithComments[] = statements.map((piece) => ({
    sql: piece.text,
    commentBlocks: [],
    leadingBlocks: [],
  }))
  let index = 0
  // The offset of the last comment kept for the statement at `index`.
  let previousOffset: number | undefined
  for (const comment of comments) {
    while (index < statements.length && (statements[index]?.end ?? 0) <= comment.offset) {
      index += 1
      previousOffset = undefined
    }
    const target = result[index]
    const piece = statements[index]
    if (target === undefined || piece === undefined) break
    if (!comment.ownLine) continue
    const blocks = target.commentBlocks
    const last = blocks[blocks.length - 1]
    if (last !== undefined && previousOffset !== undefined && stripped.slice(previousOffset, comment.offset).trim() === '') {
      last.push(comment.text)
    } else {
      blocks.push([comment.text])
      // The comments of one block are only whitespace apart, so its first one tells.
      if (comment.offset <= piece.start && stripped.slice(comment.offset, piece.start).trim() === '') {
        target.leadingBlocks.push(blocks[blocks.length - 1] ?? [])
      }
    }
    previousOffset = comment.offset
  }
  return result
}

/**
 * The statements chkit ran before #562, when the splitter did not know `//`,
 * `# ` and `#!` comments: it cut at a `;` inside one and read a quote, `/*` or
 * `$tag$` inside one as live. Only for telling whether a migration that an
 * older chkit applied in part resumes at the statements it recorded.
 */
export function extractLegacyExecutableStatements(sql: string): string[] {
  return extract(sql, BEFORE_562).statements.map((piece) => piece.text)
}

interface Piece {
  text: string
  /** The offset of its first non-whitespace character. */
  start: number
  /** The offset of the `;` that ends it, or the end of its last character. */
  end: number
}

interface LineComment {
  /** Its offset in the text with `--` comments stripped. */
  offset: number
  text: string
  /** Only whitespace comes before it on its line. */
  ownLine: boolean
}

function split(sql: string, options: SplitOptions): Piece[] {
  const statements: Piece[] = []
  let current = ''
  let currentStart = 0
  const lexedEnd = lexedEndAt(sql)

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? ''

    const end = regionEnd(sql, i, lexedEnd, options)
    if (end !== undefined) {
      current += sql.slice(i, end)
      i = end - 1
      continue
    }

    if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed.length > 0) statements.push({ text: `${trimmed};`, start: startOf(current, currentStart), end: i })
      current = ''
      currentStart = i + 1
      continue
    }

    current += ch
  }

  const tail = current.trim()
  if (tail.length > 0) statements.push({ text: `${tail};`, start: startOf(current, currentStart), end: sql.length - (current.length - current.trimEnd().length) })
  return statements
}

// `current` is the text from `currentStart` on, so its first non-whitespace
// character is this many characters further.
function startOf(current: string, currentStart: number): number {
  return currentStart + current.length - current.trimStart().length
}

function extract(
  sql: string,
  options: SplitOptions,
): { statements: Piece[]; comments: LineComment[]; stripped: string } {
  // Strip single-line comments (--) while respecting quoted strings.
  // We can't use a naive line-based filter because `--` inside string
  // literals must be preserved.
  let stripped = ''
  const comments: LineComment[] = []
  const lexedEnd = lexedEndAt(sql)

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? ''
    const next = sql[i + 1] ?? ''

    if (ch === '-' && next === '-') {
      // The comment runs to the end of the line; the newline stays.
      const newline = sql.indexOf('\n', i)
      const lineStart = sql.lastIndexOf('\n', i - 1) + 1
      comments.push({
        offset: stripped.length,
        text: sql.slice(i, newline === -1 ? sql.length : newline).trim(),
        ownLine: sql.slice(lineStart, i).trim() === '',
      })
      if (newline === -1) break
      i = newline - 1
      continue
    }

    const end = regionEnd(sql, i, lexedEnd, options)
    if (end !== undefined) {
      stripped += sql.slice(i, end)
      i = end - 1
      continue
    }

    stripped += ch
  }

  const statements = split(stripped, options)
  // A statement made only of comments is not executable: ClickHouse rejects it
  // as "Empty query" (for example a block comment after the last statement).
  const executable = statements.filter((piece) => hasExecutableContent(piece.text))
  if (executable.length === statements.length) return { statements, comments, stripped }
  // Before #562 the splitter cut a `#` or `//` comment that holds a `;` in two;
  // keeping the comment-only piece made ClickHouse reject the file instead of
  // running the commented-out text after the `;`.
  if (!options.lineComments && tokenizeSQL(stripped).some(isLineCommentWithSemicolon)) return { statements, comments, stripped }
  return { statements: executable, comments, stripped }
}

// The end of the string, quoted identifier, block comment, heredoc or, when
// the options read them, `//`, `# ` or `#!` comment that starts at `i`.
function regionEnd(
  sql: string,
  i: number,
  lexedEnd: (i: number) => number | undefined,
  options: SplitOptions,
): number | undefined {
  const end = quotedEnd(sql, i, lexedEnd)
  if (end !== undefined || !options.lineComments) return end
  return lineCommentEnd(sql, i)
}

// ClickHouse reads `//`, `# ` and `#!` as a comment up to the next `\n`, which
// stays; `#` before anything else is not a comment (ClickHouse rejects it).
function lineCommentEnd(sql: string, i: number): number | undefined {
  const ch = sql[i]
  const next = sql[i + 1]
  if (!(ch === '/' && next === '/') && !(ch === '#' && (next === ' ' || next === '!'))) return undefined
  const newline = sql.indexOf('\n', i)
  return newline === -1 ? sql.length : newline
}

// Where the ClickHouse lexer reads a heredoc, a block comment (they nest) or a
// backtick-quoted name (with backslash escapes), the offset of its first
// character maps to its end. The scanner takes these ends only where it is at
// such a token itself. The legacy split does not know `//` and `#` comments, so
// inside one it keeps its own reading and statements end where they did before
// #562. The input is lexed once, only as far as an offset the scanner asks about, and
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
    const close = sql.indexOf('*/', i + 2)
    if (close === -1) return sql.length
    // The lexer nests comments: it ends elsewhere only when a `/*` opens first.
    const nested = sql.slice(i + 2, close + 1).includes('/*')
    return nested ? (lexedEnd(i) ?? close + 2) : close + 2
  }
  if (ch === '`') {
    const close = sql.indexOf('`', i + 1)
    if (close === -1) return sql.length
    // The lexer reads backslash escapes and doubled backticks, so it can end later.
    const escaped = sql.slice(i + 1, close).includes('\\') || sql[close + 1] === '`'
    return escaped ? (lexedEnd(i) ?? close + 1) : close + 1
  }
  if (ch === "'" || ch === '"') return quoteEnd(sql, i, ch)
  if (ch === '$') {
    // Only a heredoc ClickHouse reads: not an unclosed `$tag$`, nor a `$` inside a name.
    HEREDOC_OPEN.lastIndex = i
    return HEREDOC_OPEN.test(sql) ? lexedEnd(i) : undefined
  }
  return undefined
}

const HEREDOC_OPEN = /\$[A-Za-z0-9_]*\$/y

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
