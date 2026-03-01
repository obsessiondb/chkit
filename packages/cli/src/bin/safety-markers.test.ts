import { describe, expect, test } from 'bun:test'

import { extractExecutableStatements } from './safety-markers.js'

describe('extractExecutableStatements', () => {
  test('splits simple statement batches', () => {
    const sql = `
      CREATE TABLE app.events (id UInt64);
      ALTER TABLE app.events ADD COLUMN name String;
    `

    expect(extractExecutableStatements(sql)).toEqual([
      'CREATE TABLE app.events (id UInt64);',
      'ALTER TABLE app.events ADD COLUMN name String;',
    ])
  })

  test('does not split on semicolons inside quoted strings', () => {
    const sql = `
      INSERT INTO app.logs (message) VALUES ('first;second');
      INSERT INTO app.logs (message) VALUES ("third;fourth");
      INSERT INTO app.logs (message) VALUES ('it''s;fine');
    `

    expect(extractExecutableStatements(sql)).toEqual([
      "INSERT INTO app.logs (message) VALUES ('first;second');",
      'INSERT INTO app.logs (message) VALUES ("third;fourth");',
      "INSERT INTO app.logs (message) VALUES ('it''s;fine');",
    ])
  })

  test('does not split on semicolons in backtick identifiers or block comments', () => {
    const sql = `
      /* migration metadata ; keep as comment */
      ALTER TABLE app.events ADD COLUMN \`semi;name\` String;
      /* another ; comment */ ALTER TABLE app.events DROP COLUMN IF EXISTS old_col;
    `

    expect(extractExecutableStatements(sql)).toEqual([
      '/* migration metadata ; keep as comment */\n      ALTER TABLE app.events ADD COLUMN `semi;name` String;',
      '/* another ; comment */ ALTER TABLE app.events DROP COLUMN IF EXISTS old_col;',
    ])
  })

  test('ignores full-line comments while preserving executable statements', () => {
    const sql = `
      -- operation: alter_table_drop_column key=table:app.events:column:old_col risk=danger
      -- sql: ALTER TABLE app.events DROP COLUMN old_col;
      ALTER TABLE app.events DROP COLUMN IF EXISTS old_col;
    `

    expect(extractExecutableStatements(sql)).toEqual([
      'ALTER TABLE app.events DROP COLUMN IF EXISTS old_col;',
    ])
  })
})
