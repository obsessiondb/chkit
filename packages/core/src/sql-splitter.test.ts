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
