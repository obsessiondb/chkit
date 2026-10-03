import { describe, expect, test } from 'bun:test'

import { identifierName, isTrivia, stringLiteralValue, tokenizeSQL, type SQLToken } from './sql-lexer.js'

function kinds(sql: string): Array<[SQLToken['kind'], string]> {
  return tokenizeSQL(sql).map((token) => [token.kind, token.text])
}

describe('tokenizeSQL', () => {
  test('is lossless and offsets are contiguous', () => {
    const inputs = [
      "SELECT a.b, 'it''s', `x``y`, \"q\"\"r\" FROM db.t -- trailing\nWHERE x = 1 /* a /* b */ c */ # note\n#!shebang\n",
      "SELECT $$it's -- not a comment$$, $tag$x $$ y$tag$, 'unterminated",
      '/* unterminated block',
      '`unterminated identifier',
      'SELECT 1.5e+3, 0x1F, a$b, $x, $, 𝔸',
      'SELECT 1 AS 1m_rollup, t.1.2, .5e3, 1_000 FROM 2024db.events // note\n',
      "SELECT 4 //2\n, 'http://x', a//*x*/b",
      '',
    ]
    for (const input of inputs) {
      const tokens = tokenizeSQL(input)
      expect(tokens.map((t) => t.text).join('')).toBe(input)
      let offset = 0
      for (const token of tokens) {
        expect(token.start).toBe(offset)
        expect(token.end).toBe(offset + token.text.length)
        offset = token.end
      }
    }
  })

  test('classifies line comments: --, "# " and "#!" but not "#x"', () => {
    expect(kinds('a--x\nb')).toEqual([
      ['identifier', 'a'],
      ['line_comment', '--x'],
      ['whitespace', '\n'],
      ['identifier', 'b'],
    ])
    expect(kinds('# x')).toEqual([['line_comment', '# x']])
    expect(kinds('#!x')).toEqual([['line_comment', '#!x']])
    expect(kinds('#x')).toEqual([
      ['punctuation', '#'],
      ['identifier', 'x'],
    ])
  })

  test('reads // as a line comment that takes precedence over /*', () => {
    expect(kinds('// note')).toEqual([['line_comment', '// note']])
    expect(kinds('4 //2\nx')).toEqual([
      ['number', '4'],
      ['whitespace', ' '],
      ['line_comment', '//2'],
      ['whitespace', '\n'],
      ['identifier', 'x'],
    ])
    expect(kinds('a//*x*/b')).toEqual([
      ['identifier', 'a'],
      ['line_comment', '//*x*/b'],
    ])
    expect(kinds("'http://x'")).toEqual([['string', "'http://x'"]])
    expect(kinds('4 / 2')).toEqual([
      ['number', '4'],
      ['whitespace', ' '],
      ['punctuation', '/'],
      ['whitespace', ' '],
      ['number', '2'],
    ])
  })

  test('keeps nested block comments as one token', () => {
    expect(kinds('/* a /* b */ c */x')).toEqual([
      ['block_comment', '/* a /* b */ c */'],
      ['identifier', 'x'],
    ])
  })

  test('keeps comment markers inside strings and quoted identifiers', () => {
    expect(kinds("'--' `#x` \"/*\"")).toEqual([
      ['string', "'--'"],
      ['whitespace', ' '],
      ['quoted_identifier', '`#x`'],
      ['whitespace', ' '],
      ['quoted_identifier', '"/*"'],
    ])
  })

  test('handles doubled and backslash-escaped quotes', () => {
    expect(kinds("'a''b' 'c\\'d'")).toEqual([
      ['string', "'a''b'"],
      ['whitespace', ' '],
      ['string', "'c\\'d'"],
    ])
  })

  test('reads $$ and $tag$ heredocs as strings only when closed', () => {
    expect(kinds("$$it's$$")).toEqual([['string', "$$it's$$"]])
    expect(kinds('$t$a$b$t$')).toEqual([['string', '$t$a$b$t$']])
    expect(kinds('$abc')).toEqual([['identifier', '$abc']])
    expect(kinds('a$$b$$')).toEqual([['identifier', 'a$$b$$']])
    expect(kinds('$$abc')).toEqual([
      ['punctuation', '$'],
      ['identifier', '$abc'],
    ])
    expect(kinds('$ x')).toEqual([
      ['punctuation', '$'],
      ['whitespace', ' '],
      ['identifier', 'x'],
    ])
  })

  test('reads a digit-led run as a name when word characters continue the number (#231)', () => {
    expect(kinds('app.1m_rollup')).toEqual([
      ['identifier', 'app'],
      ['punctuation', '.'],
      ['identifier', '1m_rollup'],
    ])
    expect(kinds('2024db.events')).toEqual([
      ['identifier', '2024db'],
      ['punctuation', '.'],
      ['identifier', 'events'],
    ])
    for (const name of ['2024_events', '1e5x', '0x1G', '0b101x']) {
      expect(kinds(name)).toEqual([['identifier', name]])
    }
    // ClickHouse ends such a name at `$`: `1a$b` is `1a` followed by `$b`.
    expect(kinds('1a$b')).toEqual([
      ['identifier', '1a'],
      ['identifier', '$b'],
    ])
  })

  test('keeps numeric literals and tuple access as numbers', () => {
    for (const literal of ['1.5e+3', '0x1F', '1_000', '0b101', '42', '.5e3']) {
      expect(kinds(literal)).toEqual([['number', literal]])
    }
    expect(kinds('t.1')).toEqual([
      ['identifier', 't'],
      ['punctuation', '.'],
      ['number', '1'],
    ])
    expect(kinds('t.1.2')).toEqual([
      ['identifier', 't'],
      ['punctuation', '.'],
      ['number', '1'],
      ['punctuation', '.'],
      ['number', '2'],
    ])
    // After a dot only digits form a number, so `1e5` there is a name.
    expect(kinds('db.1e5')).toEqual([
      ['identifier', 'db'],
      ['punctuation', '.'],
      ['identifier', '1e5'],
    ])
    expect(kinds('1.x')).toEqual([
      ['number', '1'],
      ['punctuation', '.'],
      ['identifier', 'x'],
    ])
  })

  test('marks unterminated strings, identifiers and block comments', () => {
    expect(tokenizeSQL("x 'abc").at(-1)).toMatchObject({ kind: 'string', text: "'abc", terminated: false })
    expect(tokenizeSQL('`abc').at(-1)).toMatchObject({ kind: 'quoted_identifier', terminated: false })
    expect(tokenizeSQL('/* a /* b */').at(-1)).toMatchObject({ kind: 'block_comment', terminated: false })
    expect(tokenizeSQL("'abc'")[0]?.terminated).toBe(true)
  })

  test('isTrivia covers whitespace and every comment kind', () => {
    const significant = tokenizeSQL(' --a\n/*b*/x // c\ny # d').filter((t) => !isTrivia(t))
    expect(significant.map((t) => t.text)).toEqual(['x', 'y'])
  })
})

describe('identifierName / stringLiteralValue', () => {
  test('unquotes identifiers', () => {
    const [bare, , backtick, , double, , digitLed] = tokenizeSQL('abc `a``b` "c""d" 1m_rollup')
    expect(bare && identifierName(bare)).toBe('abc')
    expect(backtick && identifierName(backtick)).toBe('a`b')
    expect(double && identifierName(double)).toBe('c"d')
    expect(digitLed && identifierName(digitLed)).toBe('1m_rollup')
  })

  test('returns undefined for non-identifiers and unterminated quotes', () => {
    const [str] = tokenizeSQL("'x'")
    const [open] = tokenizeSQL('`x')
    const [number] = tokenizeSQL('1_000')
    expect(str && identifierName(str)).toBeUndefined()
    expect(open && identifierName(open)).toBeUndefined()
    expect(number && identifierName(number)).toBeUndefined()
  })

  test('unescapes string literals and heredocs', () => {
    const [a, , b, , c] = tokenizeSQL("'it''s' 'a\\'b' $q$x'y$q$")
    expect(a && stringLiteralValue(a)).toBe("it's")
    expect(b && stringLiteralValue(b)).toBe("a'b")
    expect(c && stringLiteralValue(c)).toBe("x'y")
  })
})
