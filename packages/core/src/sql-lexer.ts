/**
 * Lossless ClickHouse SQL lexer: concatenating every token's `text` reproduces
 * the input exactly. It follows ClickHouse's own lexer closely enough to tell
 * code from strings, quoted identifiers and comments, and names from numbers;
 * it is not a parser.
 */
export type SQLTokenKind =
  | 'whitespace'
  | 'line_comment'
  | 'block_comment'
  | 'string'
  | 'quoted_identifier'
  | 'identifier'
  | 'number'
  | 'punctuation'

export interface SQLToken {
  kind: SQLTokenKind
  /** Exact source text of the token. */
  text: string
  /** Offset of the first character in the input. */
  start: number
  /** Offset just past the last character. */
  end: number
  /**
   * `false` only for a string, quoted identifier or block comment that runs to
   * the end of the input without its closing delimiter.
   */
  terminated: boolean
}

interface TokenEnd {
  kind: SQLTokenKind
  end: number
  terminated: boolean
}

const WHITESPACE = /[ \t\n\r\f\v]/
const IDENTIFIER_START = /[A-Za-z_]/
const IDENTIFIER_PART = /[A-Za-z0-9_$]/
const WORD_CHAR = /[A-Za-z0-9_]/
const WORD = /^[A-Za-z0-9_]+$/
const DIGIT = /[0-9]/
const HEX_DIGIT = /[0-9A-Fa-f]/
const HEREDOC_TAG = /[A-Za-z0-9_]/
const EXPONENT = /^[eE][+-]?[0-9]/
const HEX_EXPONENT = /^[pP][+-]?[0-9]/
const HEX_BYTE = /^[0-9A-Fa-f]{2}$/
const LAST_CONTROL_ASCII = 0x1f
// ClickHouse's parseEscapeSequence: the escapes that stand for a control byte.
const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
}
// Escaped characters that lose their backslash; any other escape keeps it, so
// a LIKE pattern's `\%` stays `\%` (parseComplexEscapeSequence).
const PLAIN_ESCAPES = new Set(['\\', "'", '"', '`', '/', '='])
// A name may start with U+FEFF (`\xEF\xBB\xBF`); it is a character, not a BOM.
const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true })

export function tokenizeSQL(sql: string): SQLToken[] {
  const tokens: SQLToken[] = []
  const heredocEnd = heredocReader(sql)
  let previous: SQLToken | undefined
  let i = 0
  while (i < sql.length) {
    const { kind, end, terminated } = readToken(sql, i, previous, heredocEnd)
    const token: SQLToken = { kind, text: sql.slice(i, end), start: i, end, terminated }
    tokens.push(token)
    if (!isTrivia(token)) previous = token
    i = end
  }
  return tokens
}

/** The tokens of `tokenizeSQL`, one at a time, for a caller that keeps few of them. */
export function* sqlTokens(sql: string): Generator<SQLToken> {
  const heredocEnd = heredocReader(sql)
  let previous: SQLToken | undefined
  let i = 0
  while (i < sql.length) {
    const { kind, end, terminated } = readToken(sql, i, previous, heredocEnd)
    const token: SQLToken = { kind, text: sql.slice(i, end), start: i, end, terminated }
    yield token
    if (!isTrivia(token)) previous = token
    i = end
  }
}

/** Whitespace and comments: tokens that never change what a statement means. */
export function isTrivia(token: SQLToken): boolean {
  return token.kind === 'whitespace' || token.kind === 'line_comment' || token.kind === 'block_comment'
}

/** The name an identifier token denotes: bare text, or the unquoted value. */
export function identifierName(token: SQLToken): string | undefined {
  if (token.kind === 'identifier') return token.text
  if (token.kind !== 'quoted_identifier' || !token.terminated) return undefined
  return unescapeQuoted(token.text.slice(1, -1), token.text[0])
}

/** The value of a terminated string literal (`'…'` or a `$tag$…$tag$` heredoc). */
export function stringLiteralValue(token: SQLToken): string | undefined {
  if (token.kind !== 'string' || !token.terminated) return undefined
  if (token.text.startsWith('$')) {
    const tagLength = token.text.indexOf('$', 1) + 1
    return token.text.slice(tagLength, token.text.length - tagLength)
  }
  return unescapeQuoted(token.text.slice(1, -1), "'")
}

/**
 * The value ClickHouse reads from the body of a quoted name or string literal
 * (readQuotedString): a doubled `quote` is one quote, `\xHH` is a byte, `\N` is
 * nothing, `\n` and the other control escapes are their byte, `\\`, `\'`, `\"`,
 * `` \` ``, `\/` and `\=` drop the backslash, and any other escape keeps it
 * (`\q` is `\q`). The bytes read as UTF-8. An invalid `\x` (`\xZZ`) stays as
 * written, where ClickHouse reads an arbitrary byte.
 */
export function unescapeQuoted(body: string, quote = '`'): string {
  let out = ''
  let bytes: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? ''
    const next = body[i + 1] ?? ''
    if (char === '\\' && next === 'x' && HEX_BYTE.test(body.slice(i + 2, i + 4))) {
      bytes.push(Number.parseInt(body.slice(i + 2, i + 4), 16))
      i += 3
      continue
    }
    // `\N` adds no byte, so `\xC3\N\xA9` is still `é`.
    if (char === '\\' && next === 'N') {
      i += 1
      continue
    }
    if (bytes.length > 0) {
      out += UTF8.decode(Uint8Array.from(bytes))
      bytes = []
    }
    if (char === '\\' && next !== '') {
      i += 1
      const decoded = CONTROL_ESCAPES[next] ?? next
      // A raw control character after a backslash drops it too (isControlASCII).
      if (!PLAIN_ESCAPES.has(decoded) && decoded.charCodeAt(0) > LAST_CONTROL_ASCII) out += '\\'
      out += decoded
      continue
    }
    if (char === quote && next === quote) {
      out += quote
      i += 1
      continue
    }
    out += char
  }
  return bytes.length > 0 ? out + UTF8.decode(Uint8Array.from(bytes)) : out
}

// `previous` is the last token that is not trivia; ClickHouse uses it to tell
// a qualifier dot from the start of a number.
function readToken(sql: string, i: number, previous: SQLToken | undefined, readHeredoc: HeredocReader): TokenEnd {
  const char = sql[i] ?? ''
  const next = sql[i + 1] ?? ''
  if (WHITESPACE.test(char)) return complete('whitespace', skipWhile(sql, i, WHITESPACE))
  // `--x`, `//x`, `# x` and `#!x` are line comments; `#x` is not (ClickHouse rejects it).
  if (
    (char === '-' && next === '-') ||
    (char === '/' && next === '/') ||
    (char === '#' && (next === ' ' || next === '!'))
  ) {
    return complete('line_comment', lineEnd(sql, i))
  }
  if (char === '/' && next === '*') return readBlockComment(sql, i)
  if (char === "'") return { kind: 'string', ...readQuoted(sql, i, "'") }
  if (char === '`' || char === '"') return { kind: 'quoted_identifier', ...readQuoted(sql, i, char) }
  if (char === '$') {
    const heredocEnd = readHeredoc(i)
    if (heredocEnd !== undefined) return complete('string', heredocEnd)
    if (WORD_CHAR.test(next)) return complete('identifier', skipWhile(sql, i, IDENTIFIER_PART))
  }
  if (DIGIT.test(char)) return readNumberOrWord(sql, i, previous?.text === '.')
  if (char === '.' && DIGIT.test(next) && !endsOperand(previous)) return complete('number', fractionEnd(sql, i))
  if (IDENTIFIER_START.test(char)) return complete('identifier', skipWhile(sql, i, IDENTIFIER_PART))
  const codePoint = sql.codePointAt(i) ?? 0
  return complete('punctuation', i + String.fromCodePoint(codePoint).length)
}

// ClickHouse reads a digit-led run as a numeric literal and, when word
// characters continue it, as a bare word: `1m_rollup` and `2024db` are names,
// while `1_000`, `1.5e+3` and `0x1F` are numbers. Right after a `.` only
// integer digits form the literal, so `t.1.2` is tuple access and `db.1e5` is a
// name. Word characters exclude `$` here: `1a$b` is `1a` followed by `$b`.
function readNumberOrWord(sql: string, i: number, afterDot: boolean): TokenEnd {
  const literalEnd = afterDot ? digitsEnd(sql, i, DIGIT) : numericLiteralEnd(sql, i)
  const end = skipWhile(sql, literalEnd, WORD_CHAR)
  const isName = end > literalEnd && WORD.test(sql.slice(i, end))
  return complete(isName ? 'identifier' : 'number', end)
}

// An optional 0x/0b prefix, digits, an optional fraction and an optional
// exponent. A `.` joins the literal only before a digit, so `1.x` keeps its dot.
function numericLiteralEnd(sql: string, i: number): number {
  const prefix = sql.slice(i, i + 3)
  const hex = /^0[xX][0-9A-Fa-f]/.test(prefix)
  const digit = hex ? HEX_DIGIT : DIGIT
  let j = digitsEnd(sql, hex || /^0[bB][01]/.test(prefix) ? i + 2 : i, digit)
  if (sql[j] === '.' && DIGIT.test(sql[j + 1] ?? '')) j = digitsEnd(sql, j + 1, digit)
  const exponent = (hex ? HEX_EXPONENT : EXPONENT).exec(sql.slice(j, j + 3))
  return exponent ? digitsEnd(sql, j + exponent[0].length - 1, DIGIT) : j
}

// One block of digits; `_` may separate two digits (`1_000`).
function digitsEnd(sql: string, i: number, digit: RegExp): number {
  let j = i
  while (j < sql.length) {
    const char = sql[j] ?? ''
    const separator = char === '_' && j > i && digit.test(sql[j + 1] ?? '')
    if (!digit.test(char) && !separator) break
    j += 1
  }
  return j
}

// `.5` or `.5e3` where a value starts.
function fractionEnd(sql: string, i: number): number {
  const j = skipWhile(sql, i + 1, DIGIT)
  const exponent = EXPONENT.exec(sql.slice(j, j + 3))
  return exponent ? skipWhile(sql, j + exponent[0].length - 1, DIGIT) : j
}

// After a name, a number, `)` or `]`, a `.` is a qualifier or tuple access.
function endsOperand(token: SQLToken | undefined): boolean {
  if (token === undefined) return false
  return (
    token.kind === 'identifier' ||
    token.kind === 'quoted_identifier' ||
    token.kind === 'number' ||
    token.text === ')' ||
    token.text === ']'
  )
}

// ClickHouse block comments nest: `/* a /* b */ c */` is one comment.
function readBlockComment(sql: string, i: number): TokenEnd {
  let depth = 0
  let j = i
  while (j < sql.length) {
    if (sql.startsWith('/*', j)) {
      depth += 1
      j += 2
    } else if (sql.startsWith('*/', j)) {
      depth -= 1
      j += 2
      if (depth === 0) return complete('block_comment', j)
    } else {
      j += 1
    }
  }
  return { kind: 'block_comment', end: sql.length, terminated: false }
}

// A doubled delimiter or a backslash escapes the delimiter inside quotes.
function readQuoted(sql: string, i: number, quote: string): { end: number; terminated: boolean } {
  let j = i + 1
  while (j < sql.length) {
    const char = sql[j]
    if (char === '\\') {
      j += 2
      continue
    }
    if (char === quote) {
      if (sql[j + 1] === quote) {
        j += 2
        continue
      }
      return { end: j + 1, terminated: true }
    }
    j += 1
  }
  return { end: sql.length, terminated: false }
}

/** The end of the heredoc that opens at `i`, or undefined when none does. */
type HeredocReader = (i: number) => number | undefined

// `$tag$ … $tag$` (including `$$ … $$`), where the tag is `[A-Za-z0-9_]*`. It
// is only a literal when the same tag closes it later; otherwise ClickHouse
// reads the `$` as part of an identifier or as punctuation. The closer is the
// first later occurrence of the opener's text. Searching the rest of the input
// once per opener is quadratic on many unclosed openers (#585), so the first
// opener indexes every `$tag$` in the input and each one is a lookup.
function heredocReader(sql: string): HeredocReader {
  let tagStarts: Map<string, number[]> | undefined
  return (i) => {
    const tagEnd = skipWhile(sql, i + 1, HEREDOC_TAG)
    if (sql[tagEnd] !== '$') return undefined
    tagStarts ??= indexHeredocTags(sql)
    const close = firstAtOrAfter(tagStarts.get(sql.slice(i + 1, tagEnd)) ?? [], tagEnd + 1)
    return close === undefined ? undefined : close + tagEnd + 1 - i
  }
}

// Every offset where `$tag$` occurs, in order, by tag. An occurrence is a `$`,
// the longest run of tag characters after it, then a `$` (a tag character is
// never `$`), so each `$` starts at most one and the scan is linear.
function indexHeredocTags(sql: string): Map<string, number[]> {
  const starts = new Map<string, number[]>()
  for (let i = sql.indexOf('$'); i !== -1; i = sql.indexOf('$', i + 1)) {
    const tagEnd = skipWhile(sql, i + 1, HEREDOC_TAG)
    if (sql[tagEnd] !== '$') continue
    const tag = sql.slice(i + 1, tagEnd)
    const offsets = starts.get(tag)
    if (offsets === undefined) starts.set(tag, [i])
    else offsets.push(i)
  }
  return starts
}

// The first of the ascending `offsets` that is at least `from`.
function firstAtOrAfter(offsets: number[], from: number): number | undefined {
  let low = 0
  let high = offsets.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((offsets[middle] ?? 0) < from) low = middle + 1
    else high = middle
  }
  return offsets[low]
}

function complete(kind: SQLTokenKind, end: number): TokenEnd {
  return { kind, end, terminated: true }
}

function skipWhile(sql: string, i: number, pattern: RegExp): number {
  let j = i
  while (j < sql.length && pattern.test(sql[j] ?? '')) j += 1
  return j
}

function lineEnd(sql: string, i: number): number {
  const newline = sql.indexOf('\n', i)
  return newline === -1 ? sql.length : newline
}
