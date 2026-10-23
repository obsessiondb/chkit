import { describe, expect, test } from 'bun:test'

import { parseModifyColumnIntent, parseRenameColumn } from './alter-column-statement.js'

describe('parseModifyColumnIntent', () => {
  test('reads the default kind and expression up to the comment and codec', () => {
    expect(
      parseModifyColumnIntent(
        "ALTER TABLE app.events ON CLUSTER 'c' MODIFY COLUMN `size` Nullable(UInt64) DEFAULT length(raw) + 1 COMMENT 'it''s' CODEC(ZSTD(3));",
        'size',
      ),
    ).toEqual({ defaultKind: 'DEFAULT', defaultExpression: 'length(raw) + 1', comment: "it's" })
  })

  test('keeps nested commas, brackets and keywords inside the expression', () => {
    expect(
      parseModifyColumnIntent(
        "ALTER TABLE t MODIFY COLUMN m Map(String, Array(UInt8)) MATERIALIZED map('a', [1, 2]) COMMENT 'x'",
        'm',
      ),
    ).toEqual({ defaultKind: 'MATERIALIZED', defaultExpression: "map('a', [1, 2])", comment: 'x' })
    expect(parseModifyColumnIntent('ALTER TABLE t MODIFY COLUMN c String ALIAS if(a > 1, comment, b);', 'c')).toEqual({
      defaultKind: 'ALIAS',
      defaultExpression: 'if(a > 1, comment, b)',
    })
  })

  test('reads an EPHEMERAL default and a bare EPHEMERAL', () => {
    expect(parseModifyColumnIntent("ALTER TABLE t MODIFY COLUMN `raw` String EPHEMERAL 'seed';", 'raw')).toEqual({
      defaultKind: 'EPHEMERAL',
      defaultExpression: "'seed'",
    })
    expect(parseModifyColumnIntent('ALTER TABLE t MODIFY COLUMN `raw` String EPHEMERAL;', 'raw')).toEqual({
      defaultKind: 'EPHEMERAL',
      typeDefault: true,
    })
  })

  test('sets nothing a type-only MODIFY leaves in place', () => {
    expect(parseModifyColumnIntent('ALTER TABLE t MODIFY COLUMN `code` UInt64 CODEC(Delta, ZSTD);', 'code')).toEqual({})
  })

  test('reads REMOVE of a default, a codec and a comment', () => {
    expect(parseModifyColumnIntent('ALTER TABLE t MODIFY COLUMN `day` REMOVE MATERIALIZED;', 'day')).toEqual({ defaultKind: '' })
    expect(parseModifyColumnIntent('ALTER TABLE t MODIFY COLUMN `day` REMOVE CODEC;', 'day')).toEqual({ codecRemoved: true })
    expect(parseModifyColumnIntent('ALTER TABLE t MODIFY COLUMN `day` REMOVE COMMENT;', 'day')).toEqual({ comment: '' })
  })

  test('sets nothing for another column or another statement', () => {
    expect(parseModifyColumnIntent("ALTER TABLE t MODIFY COLUMN a String DEFAULT 'x';", 'b')).toEqual({})
    expect(parseModifyColumnIntent("ALTER TABLE t ADD COLUMN a String DEFAULT 'x';", 'a')).toEqual({})
    expect(parseModifyColumnIntent("ALTER TABLE t MODIFY COLUMN a String DEFAULT 'x' -- note\n;", 'a')).toEqual({
      defaultKind: 'DEFAULT',
      defaultExpression: "'x'",
    })
  })
})

describe('parseRenameColumn', () => {
  test('reads quoted and bare names, with or without IF EXISTS', () => {
    expect(parseRenameColumn('ALTER TABLE app.t RENAME COLUMN IF EXISTS `a:b` TO `c\\`d`;')).toEqual({ from: 'a:b', to: 'c`d' })
    expect(parseRenameColumn('ALTER TABLE app.t RENAME COLUMN x TO y')).toEqual({ from: 'x', to: 'y' })
  })

  test('returns undefined for other statements', () => {
    expect(parseRenameColumn('RENAME TABLE a TO b')).toBeUndefined()
  })
})
