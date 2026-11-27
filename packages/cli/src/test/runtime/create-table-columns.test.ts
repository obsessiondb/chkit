import { describe, expect, test } from 'bun:test'

import { createTableElementNames } from '../../runtime/create-table-columns.js'

// Renderings of the same journal under show_create_query_identifier_quoting_style
// and _rule, as ClickHouse 26.8 prints them in system.tables.create_table_query.
const BACKTICKS =
  "CREATE TABLE db._chkit_migrations (`name` String, `operations` Array(Tuple(operation_index Int32, last_error String)) DEFAULT [], `operation_fingerprints` Array(String) DEFAULT [] COMMENT 'x', `a b` UInt8) ENGINE = SharedMergeTree ORDER BY name SETTINGS index_granularity = 1"
const DOUBLE_QUOTES =
  'CREATE TABLE "db"."_chkit_migrations" ("name" String, "operations" Array(Tuple(operation_index Int32, last_error String)) DEFAULT [], "operation_fingerprints" Array(String) DEFAULT [] COMMENT \'x\', "a b" UInt8) ENGINE = SharedMergeTree ORDER BY "name"'
const BARE =
  "CREATE TABLE db._chkit_migrations (`name` String, operations Array(Tuple(operation_index Int32, last_error String)) DEFAULT [], operation_fingerprints Array(String) DEFAULT [] COMMENT 'x', `a b` UInt8) ENGINE = SharedMergeTree ORDER BY `name`"

describe('createTableElementNames', () => {
  test('reads the column names whatever the identifier quoting', () => {
    for (const sql of [BACKTICKS, DOUBLE_QUOTES, BARE]) {
      expect(createTableElementNames(sql)).toEqual(['name', 'operations', 'operation_fingerprints', 'a b'])
    }
  })

  test('a comment, default or string that mentions a name does not define it', () => {
    const sql =
      "CREATE TABLE db.j (`name` String COMMENT 'operation_fingerprints, `operation_fingerprints` Array(String)', `x` String DEFAULT 'a,\\'operation_fingerprints\\'' /* , operation_fingerprints Array(String) */) ENGINE = MergeTree ORDER BY name COMMENT 'operation_fingerprints'"
    expect(createTableElementNames(sql)).toEqual(['name', 'x'])
  })

  test('names an index, projection or constraint too, so a mistake reads as present', () => {
    expect(
      createTableElementNames(
        'CREATE TABLE db.j (`name` String, INDEX operation_fingerprints name TYPE minmax, PROJECTION p (SELECT name), CONSTRAINT c CHECK 1) ENGINE = MergeTree ORDER BY name',
      ),
    ).toEqual(['name', 'INDEX', 'operation_fingerprints', 'PROJECTION', 'p', 'CONSTRAINT', 'c'])
  })

  test('unescapes quoted names', () => {
    expect(createTableElementNames('CREATE TABLE db.j (`a``b` String, "c\\"d" String, `e\\`f` String) ENGINE = Log')).toEqual([
      'a`b',
      'c"d',
      'e`f',
    ])
  })

  test('cannot read a statement without a closed column list', () => {
    for (const sql of ['', 'CREATE TABLE db.j ENGINE = Log', 'CREATE TABLE db.j (`name` String', "CREATE TABLE db.j (`name` String COMMENT 'x) ENGINE = Log", 'CREATE TABLE db.j () ENGINE = Log', 'CREATE TABLE db.j (, `name` String) ENGINE = Log', 'CREATE TABLE db.j (`name String) ENGINE = Log', 'CREATE TABLE db.j (`name` String /* x) ENGINE = Log']) {
      expect(createTableElementNames(sql)).toBeUndefined()
    }
  })
})
