import { describe, expect, test } from 'bun:test'

import { extractExecutableStatements, splitSqlStatements } from './sql-splitter.js'

describe('splitSqlStatements', () => {
  test('splits multiple statements and re-appends the terminating semicolon', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1;', 'SELECT 2;'])
  })

  test('appends a semicolon to a trailing statement that lacks one', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1;', 'SELECT 2;'])
  })

  test('trims surrounding whitespace around each statement', () => {
    expect(splitSqlStatements('  SELECT 1 ;\n\n  SELECT 2  ')).toEqual(['SELECT 1;', 'SELECT 2;'])
  })

  test('drops empty statements produced by repeated semicolons', () => {
    expect(splitSqlStatements('SELECT 1;;;SELECT 2;')).toEqual(['SELECT 1;', 'SELECT 2;'])
  })

  test('returns an empty array for empty input', () => {
    expect(splitSqlStatements('')).toEqual([])
  })

  test('returns an empty array for whitespace-only input', () => {
    expect(splitSqlStatements('   \n\t  \n')).toEqual([])
  })

  test('does not split on a semicolon inside a single-quoted string', () => {
    expect(splitSqlStatements("INSERT INTO t VALUES ('a;b');")).toEqual([
      "INSERT INTO t VALUES ('a;b');",
    ])
  })

  test('keeps doubled single-quote escapes and their semicolons intact', () => {
    expect(splitSqlStatements("SELECT 'it''s; fine';")).toEqual(["SELECT 'it''s; fine';"])
  })

  test('does not split on a semicolon inside a double-quoted identifier', () => {
    expect(splitSqlStatements('SELECT "a;b" FROM t;')).toEqual(['SELECT "a;b" FROM t;'])
  })

  test('does not split on a semicolon inside a backtick-quoted identifier', () => {
    expect(splitSqlStatements('SELECT `a;b` FROM t;')).toEqual(['SELECT `a;b` FROM t;'])
  })

  test('does not split on a semicolon inside a block comment', () => {
    expect(splitSqlStatements('SELECT 1 /* a; b */; SELECT 2;')).toEqual([
      'SELECT 1 /* a; b */;',
      'SELECT 2;',
    ])
  })
})

describe('extractExecutableStatements', () => {
  test('splits multiple statements like the underlying splitter', () => {
    expect(extractExecutableStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1;', 'SELECT 2;'])
  })

  test('appends a semicolon to a trailing statement that lacks one', () => {
    expect(extractExecutableStatements('SELECT 1')).toEqual(['SELECT 1;'])
  })

  test('returns an empty array for empty input', () => {
    expect(extractExecutableStatements('')).toEqual([])
  })

  test('returns an empty array for whitespace-only input', () => {
    expect(extractExecutableStatements('   \n\t  ')).toEqual([])
  })

  test('strips a line comment and does not split on a semicolon inside it', () => {
    expect(extractExecutableStatements('-- meta: x; y\nSELECT 1;')).toEqual(['SELECT 1;'])
  })

  test('returns an empty array when input is only line comments', () => {
    expect(extractExecutableStatements('-- just a comment; not a statement\n')).toEqual([])
  })

  test('preserves a "--" sequence that appears inside a string literal', () => {
    expect(extractExecutableStatements("SELECT 'a -- b';")).toEqual(["SELECT 'a -- b';"])
  })

  test('preserves block comments and does not split on a semicolon inside them', () => {
    expect(extractExecutableStatements('/* keep; me */ SELECT 1;')).toEqual([
      '/* keep; me */ SELECT 1;',
    ])
  })

  test('does not split on a semicolon inside a single-quoted string', () => {
    expect(extractExecutableStatements("INSERT INTO t VALUES ('a;b');")).toEqual([
      "INSERT INTO t VALUES ('a;b');",
    ])
  })

  // Contract relied on by migrate/apply.ts: `-- operation:` / `-- chkit-*`
  // metadata comments are consumed separately (extractMigrationOperationSummaries
  // reads the raw SQL); the executable stream must contain only real statements,
  // with string-literal semicolons preserved.
  test('drops migration-metadata comments and returns only executable statements', () => {
    const migration = [
      '-- chkit-migration-format: v1',
      '-- operation: create_table key=table:app.users risk=safe',
      'CREATE TABLE app.users (id UInt64) ENGINE = MergeTree ORDER BY id;',
      '',
      '-- operation: alter_table_add_column key=table:app.users risk=safe',
      "ALTER TABLE app.users ADD COLUMN email String DEFAULT 'a;b@example.com';",
    ].join('\n')

    expect(extractExecutableStatements(migration)).toEqual([
      'CREATE TABLE app.users (id UInt64) ENGINE = MergeTree ORDER BY id;',
      "ALTER TABLE app.users ADD COLUMN email String DEFAULT 'a;b@example.com';",
    ])
  })
})
test('escaped trailing backslash closes a setting literal before the next statement', () => {
  const sql = String.raw`CREATE TABLE q (id String) ENGINE = Kafka SETTINGS kafka_client_id = 'a;\\';
-- next operation
CREATE MATERIALIZED VIEW mv TO stored AS SELECT id FROM q;`
  expect(extractExecutableStatements(sql)).toEqual([
    String.raw`CREATE TABLE q (id String) ENGINE = Kafka SETTINGS kafka_client_id = 'a;\\';`,
    'CREATE MATERIALIZED VIEW mv TO stored AS SELECT id FROM q;',
  ])
})

// ClickHouse rejects a query made only of comments with "Empty query" (#233),
// so such a piece is never an executable statement.
describe('extractExecutableStatements with comment-only statements', () => {
  test('splitSqlStatements still returns a comment-only piece', () => {
    expect(splitSqlStatements('/* only a comment */;')).toEqual(['/* only a comment */;'])
  })

  test('drops a statement made only of a block comment', () => {
    expect(extractExecutableStatements('/* only a comment */;')).toEqual([])
  })

  test('drops a block comment after the last statement', () => {
    expect(
      extractExecutableStatements('CREATE TABLE t (id UInt64) ENGINE = Memory;\n/* TODO */\n'),
    ).toEqual(['CREATE TABLE t (id UInt64) ENGINE = Memory;'])
  })

  test('returns nothing for a file of line and block comments', () => {
    expect(extractExecutableStatements('-- header\n/* block; with semicolon */\n-- more\n')).toEqual([])
  })

  test('drops a comment-only statement between two statements', () => {
    expect(extractExecutableStatements('SELECT 1;\n/* a */ /* b */;\nSELECT 2;')).toEqual([
      'SELECT 1;',
      'SELECT 2;',
    ])
  })

  test('drops every ClickHouse comment form', () => {
    expect(extractExecutableStatements('# note\n;')).toEqual([])
    expect(extractExecutableStatements('#! shebang\n')).toEqual([])
    expect(extractExecutableStatements('// note\n;')).toEqual([])
    expect(extractExecutableStatements('/* a /* nested */ b */;')).toEqual([])
    expect(extractExecutableStatements('SELECT 1;\n// trailing note')).toEqual(['SELECT 1;'])
  })

  test('keeps comment markers inside strings and quoted identifiers', () => {
    expect(extractExecutableStatements("SELECT '/* not a comment */';")).toEqual([
      "SELECT '/* not a comment */';",
    ])
    expect(extractExecutableStatements('SELECT `/*x*/` FROM t;')).toEqual(['SELECT `/*x*/` FROM t;'])
    expect(extractExecutableStatements("SELECT '# a; b';\n/* end */")).toEqual(["SELECT '# a; b';"])
  })

  test('keeps text ClickHouse rejects so it reports the error', () => {
    // `#x` is not a comment (ClickHouse needs `# ` or `#!`).
    expect(extractExecutableStatements('#x;')).toEqual(['#x;'])
    expect(extractExecutableStatements('SELECT 1;\n/* never closed')).toEqual([
      'SELECT 1;',
      '/* never closed;',
    ])
  })

  test('keeps a `#` or `//` comment that holds a semicolon, so the text after it never runs alone', () => {
    // ClickHouse reads the whole line as one comment; the splitter cuts it at the `;`.
    expect(extractExecutableStatements('// DROP TABLE a; DROP TABLE b;\nSELECT 1;')).toEqual([
      '// DROP TABLE a;',
      'DROP TABLE b;',
      'SELECT 1;',
    ])
    expect(extractExecutableStatements('# old: DROP TABLE a; DROP TABLE b;\n')).toEqual([
      '# old: DROP TABLE a;',
      'DROP TABLE b;',
    ])
  })

  test('returns nothing for a generate --empty scaffold', () => {
    const scaffold = [
      '-- chkit-migration-format: v1',
      '-- generated-at: 2026-01-01T00:00:00.000Z',
      '-- cli-version: 0.2.0',
      '-- definition-count: 0',
      '-- operation-count: 0',
      '-- rename-suggestion-count: 0',
      '-- risk-summary: safe=0, caution=0, danger=0',
      '',
      '-- Empty migration scaffold. Write your SQL statements below.',
      '-- Statements run in order and are separated by semicolons.',
      '',
    ].join('\n')
    expect(extractExecutableStatements(scaffold)).toEqual([])
  })
})
