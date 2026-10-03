import { describe, expect, test } from 'bun:test'

import { isTrivia, tokenizeSQL } from './sql-lexer.js'
import {
  isSyntheticEphemeralDefault,
  normalizeSQLFragment,
  sqlExpressionFingerprint,
  stripSQLComments,
} from './sql-normalizer.js'

// The view SQL from issue #232: a `--` comment with an apostrophe between CTEs.
const ISSUE_AS = [
  'WITH people_by_email AS (SELECT person_id, company_id, arrayJoin(emails) AS email FROM brain.person_identity),',
  "-- The attendee's company: through their person record, else through the email domain.",
  'meeting_company AS (',
  '  SELECT email, company_id FROM people_by_email',
  ')',
  'SELECT email, company_id FROM meeting_company',
].join('\n')

const CASES: Array<{ name: string; input: string; expected: string }> = [
  {
    name: 'issue #232: a -- comment with an apostrophe between CTEs',
    input: ISSUE_AS,
    expected:
      'WITH people_by_email AS (SELECT person_id, company_id, arrayJoin(emails) AS email FROM brain.person_identity), meeting_company AS ( SELECT email, company_id FROM people_by_email ) SELECT email, company_id FROM meeting_company',
  },
  { name: 'trailing line comment', input: 'SELECT 1 AS x\n-- trailing', expected: 'SELECT 1 AS x' },
  { name: 'line comment at the end of input', input: 'SELECT 1 AS x -- note', expected: 'SELECT 1 AS x' },
  { name: '-- without a space', input: 'SELECT 1 AS x --x\n, 2 AS y', expected: 'SELECT 1 AS x , 2 AS y' },
  { name: '-- right after a number', input: 'SELECT 1--2\n AS x', expected: 'SELECT 1 AS x' },
  { name: '# followed by a space', input: 'SELECT 1 AS x # note\n, 2 AS y', expected: 'SELECT 1 AS x , 2 AS y' },
  { name: '#! comment', input: 'SELECT 1 AS x #!note\n, 2 AS y', expected: 'SELECT 1 AS x , 2 AS y' },
  { name: '// comment', input: 'SELECT 1 AS x // note\n, 2 AS y', expected: 'SELECT 1 AS x , 2 AS y' },
  { name: '// right before digits', input: 'SELECT 4 //2\n AS x', expected: 'SELECT 4 AS x' },
  { name: '// takes precedence over /*', input: 'SELECT 1 AS a//*x*/b\n, 2 AS c', expected: 'SELECT 1 AS a , 2 AS c' },
  { name: 'block comment', input: 'SELECT /* note */ 1 AS x', expected: 'SELECT 1 AS x' },
  { name: 'nested block comment', input: 'SELECT /* a /* b */ c */ 1 AS x', expected: 'SELECT 1 AS x' },
  { name: 'multi-line block comment holding --', input: 'SELECT 1 /* -- x\n y */ AS x', expected: 'SELECT 1 AS x' },
  { name: 'a removed comment still separates tokens', input: 'SELECT a/*x*/,b FROM t', expected: 'SELECT a ,b FROM t' },
  { name: 'removing a comment never forms --', input: 'SELECT 3 -/**/-1 AS z', expected: 'SELECT 3 - -1 AS z' },
  { name: 'line comment containing /*', input: 'SELECT 1 -- a /* b\nAS x', expected: 'SELECT 1 AS x' },
  { name: 'line comment containing */', input: 'SELECT 1 -- a */ b\nAS x', expected: 'SELECT 1 AS x' },
  { name: 'apostrophe inside a block comment', input: "SELECT /* it's */ 1 AS x", expected: 'SELECT 1 AS x' },
  {
    name: 'comment markers inside a string literal are text',
    input: "SELECT 'a -- b # c // d /* e */' AS s",
    expected: "SELECT 'a -- b # c // d /* e */' AS s",
  },
  { name: 'a URL literal is text', input: "SELECT 'https://x.io/a' AS u", expected: "SELECT 'https://x.io/a' AS u" },
  {
    name: 'escaped quotes keep the literal open',
    input: "SELECT 'it''s -- x', 'it\\'s -- y' AS s -- note",
    expected: "SELECT 'it''s -- x', 'it\\'s -- y' AS s",
  },
  {
    name: 'comment markers inside quoted identifiers are text',
    input: 'SELECT 1 AS `a--b#c/*d*/`, 2 AS "x -- y"',
    expected: 'SELECT 1 AS `a--b#c/*d*/`, 2 AS "x -- y"',
  },
  {
    name: 'a heredoc is a literal',
    input: "SELECT $q$it's -- not # a /* comment $q$ AS h -- real\n, 2 AS y",
    expected: "SELECT $q$it's -- not # a /* comment $q$ AS h , 2 AS y",
  },
  { name: '$ inside a name does not open a heredoc', input: 'SELECT 1 AS x$ -- $x\n', expected: 'SELECT 1 AS x$' },
  { name: 'CRLF line endings', input: 'SELECT 1 AS x\r\n-- note\r\n, 2 AS y', expected: 'SELECT 1 AS x , 2 AS y' },
  // ClickHouse ends a line comment at \n only.
  { name: 'a lone CR does not end a line comment', input: 'SELECT 1 AS x -- note\r, 2 AS y', expected: 'SELECT 1 AS x' },
  {
    name: 'an unterminated block comment is kept for ClickHouse to report',
    input: 'SELECT 1 /* never\n closed',
    expected: 'SELECT 1 /* never closed',
  },
  {
    name: 'an unterminated string is kept for ClickHouse to report',
    input: "SELECT 'abc -- x\n FROM t",
    expected: "SELECT 'abc -- x FROM t",
  },
  { name: 'comment-only fragment', input: '-- nothing here\n/* or here */', expected: '' },
  {
    name: 'comment-free text collapses whitespace as before',
    input: '  SELECT\n\tid,\n  email\nFROM   app.users  ',
    expected: 'SELECT id, email FROM app.users',
  },
  { name: 'Unicode whitespace collapses as before', input: 'SELECT\u00a01\u2028AS x', expected: 'SELECT 1 AS x' },
  // Kept on purpose: preserving it would change existing snapshots (follow-up).
  { name: 'whitespace inside a string literal still collapses', input: "SELECT 'a  b' AS s", expected: "SELECT 'a b' AS s" },
  { name: '# followed by a letter is not a comment', input: 'SELECT 1 AS x #note', expected: 'SELECT 1 AS x #note' },
  // `#` not followed by a space or `!` is a ClickHouse syntax error. A collapsed
  // space after it would make it a `# ` comment that hides the rest.
  {
    name: 'a bare # on its own line stays a syntax error instead of hiding the next line',
    input: 'SELECT 1 AS x\n#\n, 2 AS y',
    expected: 'SELECT 1 AS x #\n, 2 AS y',
  },
  { name: 'a bare # before a tab stays a syntax error', input: 'SELECT 1 #\tx', expected: 'SELECT 1 #\nx' },
  { name: 'a bare # before a removed comment stays a syntax error', input: 'SELECT 1 #/* c */x', expected: 'SELECT 1 #\nx' },
  { name: 'a bare # before a no-break space stays a syntax error', input: 'SELECT 1 #\u00a0x', expected: 'SELECT 1 #\nx' },
]

const RANDOM_ATOMS = [
  '--', '//', '/*', '*/', '# ', '#!', '#', '$q$', '$$', "''", 'e-', 'db.t',
  'a', 'b', 'e', 'x', '1', '0', '.', '_', '!', '-', '/', '*', '\\', '(', ')', ',', ';', '+', '$',
  "'", '"', '`', ' ', ' ', '\n', '\t', '\r', '\u00a0', '\u2028',
]

describe('normalizeSQLFragment', () => {
  for (const { name, input, expected } of CASES) {
    test(name, () => {
      expect(normalizeSQLFragment(input)).toBe(expected)
    })
  }

  // Each property also checks that its inputs are mostly distinct, so a
  // generator stuck in a short cycle cannot pass on a few hundred inputs.
  test('is idempotent', () => {
    const generated = randomInputs(20_000, 232)
    expect(new Set(generated).size).toBeGreaterThan(15_000)
    const inputs = [...CASES.map((c) => c.input), ...generated]
    const unstable = inputs.filter((input) => {
      const once = normalizeSQLFragment(input)
      return normalizeSQLFragment(once) !== once
    })
    expect(unstable).toEqual([])
  })

  test('never drops SQL text and leaves no comment behind', () => {
    const generated = randomInputs(20_000, 7)
    expect(new Set(generated).size).toBeGreaterThan(15_000)
    const inputs = [...CASES.map((c) => c.input), ...generated]
    const damaged = inputs.filter((input) => {
      const normalized = normalizeSQLFragment(input)
      return significantText(normalized) !== significantText(input) || hasClosedComment(normalized)
    })
    expect(damaged).toEqual([])
  })

  // The generator, not the code under test, guarantees there is nothing to
  // strip: comment markers and `#` only ever appear inside literals.
  test('matches a plain whitespace collapse when there are no comments', () => {
    const generated = commentFreeInputs(5_000, 31)
    expect(new Set(generated).size).toBeGreaterThan(4_000)
    const changed = generated.filter((input) => normalizeSQLFragment(input) !== input.replace(/\s+/g, ' ').trim())
    expect(changed).toEqual([])
  })
})

test('unlexable expressions fall back to their normalizeSQLFragment text', () => {
  for (const value of ["$$it's", 'concat(a', 'a; b', '/* open', "'\\xZZ'"]) {
    expect(sqlExpressionFingerprint(value)).toBe(JSON.stringify(value))
  }
  expect(sqlExpressionFingerprint('concat(a;\n  x)')).toBe(sqlExpressionFingerprint(' concat(a; x) '))
  // The fallback drops comments, not only whitespace.
  expect(sqlExpressionFingerprint('concat(a -- note\n, b')).toBe(JSON.stringify('concat(a , b'))
  expect(sqlExpressionFingerprint('concat(a')).not.toBe(sqlExpressionFingerprint('concat(a)'))
})

test('heredocs fingerprint like the literal ClickHouse 26.3 stores for them', () => {
  for (const [heredoc, stored] of [
    ["$$it's$$", "'it\\'s'"],
    ["$tag$a'b$tag$", "'a\\'b'"],
    ["concat($$(x$$,'y')", "concat('(x', 'y')"],
    ['$$a\\nb$$', "'a\\\\nb'"],
    ['$$é\\$$', "'é\\\\'"],
    ['$a$$$a$', "'$'"],
    ['$$$$', "''"],
  ]) {
    expect(sqlExpressionFingerprint(heredoc)).toBe(sqlExpressionFingerprint(stored))
  }
  expect(sqlExpressionFingerprint("$$it's$$")).not.toBe(sqlExpressionFingerprint("$$its'$$"))
  // A dollar sign inside a word is part of the identifier, not a heredoc.
  expect(sqlExpressionFingerprint('x$$a$$')).toBe(JSON.stringify(['x$$a$$']))
})

test('isSyntheticEphemeralDefault accepts one defaultValueOfTypeName literal', () => {
  for (const expression of [
    "defaultValueOfTypeName('BIGINT')",
    "defaultValueOfTypeName( 'Decimal32(2)' )",
    "defaultValueOfTypeName('Enum8(\\'a\\\\b\\' = 1)')",
  ]) {
    expect(isSyntheticEphemeralDefault(expression)).toBe(true)
  }
  for (const expression of ["defaultValueOfTypeName('String') || 'x'", "defaultValueOfTypeName('a', 'b')"]) {
    expect(isSyntheticEphemeralDefault(expression)).toBe(false)
  }
})

// Column default expressions (#234): comments go, everything else stays.
const STRIP_CASES: Array<{ name: string; input: string; expected: string }> = [
  { name: 'a trailing -- comment', input: 'now() -- set on insert', expected: 'now()' },
  { name: 'a nested block comment', input: 'now() /* a /* nested */ b */ + 1', expected: 'now() + 1' },
  { name: 'a # comment', input: 'toUInt8(1) # one', expected: 'toUInt8(1)' },
  { name: '#! and // comments before a newline', input: 'x #! note\n+ y // more\n+ 1', expected: 'x + y + 1' },
  {
    name: 'comment markers inside literals, quoted identifiers and heredocs',
    input: "concat('a -- b', `c--d`, \"#e\", $$ /* f */ $$)",
    expected: "concat('a -- b', `c--d`, \"#e\", $$ /* f */ $$)",
  },
  { name: 'whitespace inside literals', input: "concat('x  y', 'a\n  b')", expected: "concat('x  y', 'a\n  b')" },
  {
    name: 'whitespace outside literals that holds no comment',
    input: 'multiIf(\n  a = 1, 2, -- one\n  3)',
    expected: 'multiIf(\n  a = 1, 2, 3)',
  },
  { name: 'tokens around a comment stay apart', input: '1 -/**/-1', expected: '1 - -1' },
  { name: 'a stray # before a comment keeps its error', input: '#/* c */x', expected: '#\nx' },
  // Whatever chkit renders after the expression must not turn the # into a `# ` comment.
  { name: 'a stray # at the end keeps its error', input: 'now() #', expected: 'now() #\n' },
  { name: 'a stray # before a final comment keeps its error', input: 'now() #\t-- c', expected: 'now() #\n' },
  { name: 'a stray # before trailing Unicode whitespace keeps its error', input: 'now() #\u00a0', expected: 'now() #\n' },
  { name: 'an unterminated block comment', input: 'now() /* oops', expected: 'now() /* oops' },
  { name: 'only comments', input: ' -- nothing\n/* here */ ', expected: '' },
]

describe('stripSQLComments', () => {
  for (const { name, input, expected } of STRIP_CASES) {
    test(name, () => {
      expect(stripSQLComments(input)).toBe(expected)
    })
  }

  test('never drops SQL text, leaves no comment behind, and is idempotent', () => {
    const generated = randomInputs(20_000, 234)
    expect(new Set(generated).size).toBeGreaterThan(15_000)
    const inputs = [...STRIP_CASES.map((c) => c.input), ...generated]
    const damaged = inputs.filter((input) => {
      const stripped = stripSQLComments(input)
      return (
        significantText(stripped) !== significantText(input) ||
        hasClosedComment(stripped) ||
        stripSQLComments(stripped) !== stripped
      )
    })
    expect(damaged).toEqual([])
  })

  test('only trims SQL without comments', () => {
    const generated = commentFreeInputs(5_000, 34)
    expect(new Set(generated).size).toBeGreaterThan(4_000)
    expect(generated.filter((input) => stripSQLComments(input) !== input.trim())).toEqual([])
  })
})

// Seeded so a failure reproduces. mulberry32 keeps its state in 32-bit integer
// math; an LCG multiplied in floating point loses its low bits past 2^53 and
// repeats after about 10,000 values.
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomInputs(count: number, seed: number): string[] {
  const random = createRandom(seed)
  const pick = (items: string[]) => items[Math.floor(random() * items.length)] ?? ''
  return Array.from({ length: count }, () =>
    Array.from({ length: Math.floor(random() * 25) }, () => pick(RANDOM_ATOMS)).join('')
  )
}

// SQL with comment markers only inside string literals, quoted identifiers and
// heredocs. Whitespace follows every `-` and `/`, so no `--`, `//` or `/*`
// forms outside them, and `#` never appears outside them.
function commentFreeInputs(count: number, seed: number): string[] {
  const random = createRandom(seed)
  const pick = (items: string[]) => items[Math.floor(random() * items.length)] ?? ''
  const literalBody = () =>
    Array.from({ length: Math.floor(random() * 6) }, () =>
      pick(['a', ' ', '  ', '\n', '\t', '\u00a0', '--', '//', '/*', '*/', '#', '# ', '#!', ';', '$'])
    ).join('')
  const pieces: Array<() => string> = [
    () => pick(['SELECT', 'FROM', 'a', 'b_1', 'x$', '1', '2.5', '1e-3', 'count', 'db.t']),
    () => pick(['(', ')', ',', '.', '+', '*', '=', '<']),
    () => `${pick(['-', '/'])}${pick([' ', '\n', '\t', '\u00a0'])}`,
    // Ends with nothing, a doubled quote, an escaped quote or an escaped backslash.
    () => `'${literalBody()}${pick(['', "''", "\\'", '\\\\'])}'`,
    () => `\`${literalBody()}\``,
    () => `"${literalBody()}"`,
    // The leading space puts the heredoc at a token start, not inside a name.
    () => ` $h$${literalBody().replace(/\$/g, '')}$h$`,
  ]
  const gaps = ['', '', ' ', '  ', '\n', '\t ', '\r\n', '\u00a0']
  const piece = () => `${pick(gaps)}${pieces[Math.floor(random() * pieces.length)]?.() ?? ''}`
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(random() * 12) }, piece).join('')
  )
}

// Every token except whitespace and closed comments, with whitespace inside
// literals collapsed: what must survive normalization.
function significantText(sql: string): string {
  return tokenizeSQL(sql)
    .filter((token) => !(isTrivia(token) && token.terminated) && !/^\s$/.test(token.text))
    .map((token) => token.text.replace(/\s+/g, ' '))
    .join('')
    .trim()
}

function hasClosedComment(sql: string): boolean {
  return tokenizeSQL(sql).some(
    (token) => (token.kind === 'line_comment' || token.kind === 'block_comment') && token.terminated
  )
}
