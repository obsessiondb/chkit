// A small lexer for text-index SQL fragments, not a SQL grammar. Keep literals
// opaque to whitespace/parenthesis handling and canonicalize their byte escapes.
const ESCAPES: Record<string, number> = {
  '0': 0,
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  e: 27,
}

function stringLiteral(body: string): string {
  const bytes: number[] = []
  for (let i = 0; i < body.length; ) {
    const char = body[i] ?? ''
    if (char === "'" && body[i + 1] === "'") {
      bytes.push(39)
      i += 2
    } else if (char === '\\') {
      const next = String.fromCodePoint(body.codePointAt(i + 1) ?? 0)
      const hex = body.slice(i + 2, i + 4)
      if (next === 'x' && /^[\da-f]{2}$/i.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        i += 4
      } else {
        // Unknown escapes (including regex \s and LIKE \%) keep their backslash.
        if (next === 'x') throw new Error('Invalid hexadecimal SQL escape')
        if (next === 'N') {
          i += 2
          continue
        }
        if (ESCAPES[next] === undefined && !["'", '"', '`', '\\', '/', '='].includes(next))
          bytes.push(92)
        bytes.push(...(ESCAPES[next] !== undefined ? [ESCAPES[next] ?? 0] : Buffer.from(next)))
        i += 1 + next.length
      }
    } else {
      const point = String.fromCodePoint(body.codePointAt(i) ?? 0)
      bytes.push(...Buffer.from(point))
      i += point.length
    }
  }
  return (
    "'" +
    bytes
      .map((byte) => {
        if (byte === 39) return "\\'"
        if (byte === 92) return '\\\\'
        if (byte >= 32 && byte < 127) return String.fromCharCode(byte)
        return `\\x${byte.toString(16).padStart(2, '0')}`
      })
      .join('') +
    "'"
  )
}

export function textSQLTokens(sql: string): string[] {
  const tokens: string[] = []
  const brackets: string[] = []
  for (let i = 0; i < sql.length; ) {
    const char = sql[i] ?? ''
    if (/\s/.test(char)) {
      i++
      continue
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2)
      i = end < 0 ? sql.length : end + 1
      continue
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) throw new Error('Unterminated SQL comment')
      i = end + 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const start = i++
      let closed = false
      while (i < sql.length) {
        if (sql[i] === '\\') {
          i += 2
          continue
        }
        if (sql[i++] === char) {
          if (sql[i] === char) {
            i++
            continue
          }
          closed = true
          break
        }
      }
      if (!closed) throw new Error('Unterminated SQL quote')
      const raw = sql.slice(start, i)
      tokens.push(char === "'" ? stringLiteral(raw.slice(1, -1)) : raw)
      continue
    }
    if (char === ';') throw new Error('Expected a SQL expression, not a statement')
    if ('([{'.includes(char)) brackets.push(char)
    if (')]}'.includes(char) && brackets.pop() !== { ')': '(', ']': '[', '}': '{' }[char]) {
      throw new Error('Unbalanced SQL brackets')
    }
    const word = sql
      .slice(i)
      .match(/^(?:\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|[\p{L}\p{N}_$]+|->|<=|>=|!=|<>|\|\||::|==)/u)?.[0]
    tokens.push(word ?? char)
    i += word?.length ?? 1
  }
  if (brackets.length) throw new Error('Unbalanced SQL brackets')
  return tokens
}

export function formatTextSQL(tokens: string[]): string {
  let sql = ''
  for (const [i, token] of tokens.entries()) {
    const previous = tokens[i - 1]
    const tight =
      i === 0 ||
      [')', ']', '}', ',', '.'].includes(token) ||
      ['(', '[', '{', '.'].includes(previous ?? '') ||
      (token === '(' && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(previous ?? ''))
    sql += (tight ? '' : ' ') + token
  }
  return sql
}

export function normalizeTextIndexSQL(sql: string): string {
  return formatTextSQL(textSQLTokens(sql))
}

export function textExpressionFingerprint(sql: string): string {
  let tokens = textSQLTokens(sql)
  // ClickHouse may add or remove the outer INDEX expression parentheses.
  while (tokens[0] === '(' && tokens.at(-1) === ')') {
    let depth = 0
    const wraps = tokens.every((token, i) => {
      if (token === '(') depth++
      if (token === ')') depth--
      return depth !== 0 || i === tokens.length - 1
    })
    if (!wraps) break
    tokens = tokens.slice(1, -1)
  }
  return formatTextSQL(tokens)
}

// Compare redundant identifier quotes without removing them from generated SQL.
export function textSQLFingerprint(sql: string): string {
  return JSON.stringify(
    textSQLTokens(sql).map((token) => token.replace(/^([`"])([A-Za-z_][A-Za-z0-9_]*)\1$/, '$2')),
  )
}
