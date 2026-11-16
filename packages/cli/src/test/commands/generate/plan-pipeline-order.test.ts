import { describe, expect, test } from 'bun:test'

import {
  planDiff,
  table,
  type ColumnDefinition,
  type MigrationOperation,
  type MigrationPlan,
  type SchemaDefinition,
} from '@chkit/core'

import {
  applyExplicitDictionaryRenames,
  applyExplicitTableRenames,
  applySelectedRenameSuggestions,
  buildExplicitColumnRenameSuggestions,
} from '../../../commands/generate/plan-pipeline.js'

function op(type: MigrationOperation['type'], key: string): MigrationOperation {
  return { type, key, risk: 'safe', sql: `-- ${type} ${key}` }
}

// What planDiff emits for a plan with dependencies: drops dependents-first and
// creates dependencies-first (neither in key order); alters in key order.
const PLAN: MigrationPlan = {
  operations: [
    op('drop_view', 'view:app.z_top'),
    op('drop_view', 'view:app.a_base'),
    op('drop_dictionary', 'dictionary:app.d_old'),
    op('drop_table', 'table:app.users'),
    op('alter_table_drop_column', 'table:app.t:column:a'),
    op('alter_table_add_column', 'table:app.t:column:b'),
    op('create_database', 'database:app'),
    op('create_table', 'table:app.customers'),
    op('create_dictionary', 'dictionary:app.d'),
    op('create_view', 'view:app.z_base'),
    op('create_view', 'view:app.a_top'),
  ],
  riskSummary: { safe: 11, caution: 0, danger: 0 },
  renameSuggestions: [],
}

function summary(plan: MigrationPlan): string[] {
  return plan.operations.map((operation) => `${operation.type} ${operation.key}`)
}

describe('plan-pipeline keeps the planner order of drops and creates (#231)', () => {
  test('table rename', () => {
    const plan = applyExplicitTableRenames(PLAN, [
      { oldDatabase: 'app', oldName: 'users', newDatabase: 'app', newName: 'customers', source: 'cli' },
    ])
    expect(summary(plan)).toEqual([
      'drop_view view:app.z_top',
      'drop_view view:app.a_base',
      'drop_dictionary dictionary:app.d_old',
      'create_database database:app',
      'alter_table_rename_table table:app.customers:rename_table',
      'alter_table_drop_column table:app.t:column:a',
      'alter_table_add_column table:app.t:column:b',
      'create_dictionary dictionary:app.d',
      'create_view view:app.z_base',
      'create_view view:app.a_top',
    ])
  })

  test('table rename into another database adds its create_database in key order', () => {
    const plan = applyExplicitTableRenames(PLAN, [
      { oldDatabase: 'app', oldName: 'users', newDatabase: 'archive', newName: 'customers', source: 'cli' },
    ])
    expect(summary(plan)).toEqual([
      'drop_view view:app.z_top',
      'drop_view view:app.a_base',
      'drop_dictionary dictionary:app.d_old',
      'create_database database:app',
      'create_database database:archive',
      'alter_table_rename_table table:archive.customers:rename_table',
      'alter_table_drop_column table:app.t:column:a',
      'alter_table_add_column table:app.t:column:b',
      'create_table table:app.customers',
      'create_dictionary dictionary:app.d',
      'create_view view:app.z_base',
      'create_view view:app.a_top',
    ])
  })

  test('dictionary rename', () => {
    const plan = applyExplicitDictionaryRenames(PLAN, [
      { oldDatabase: 'app', oldName: 'd_old', newDatabase: 'app', newName: 'd', source: 'cli' },
    ])
    expect(summary(plan)).toEqual([
      'drop_view view:app.z_top',
      'drop_view view:app.a_base',
      'drop_table table:app.users',
      'create_database database:app',
      'rename_dictionary dictionary:app.d:rename_dictionary',
      'alter_table_drop_column table:app.t:column:a',
      'alter_table_add_column table:app.t:column:b',
      'create_table table:app.customers',
      'create_view view:app.z_base',
      'create_view view:app.a_top',
    ])
  })

  test('column rename', () => {
    const plan = applySelectedRenameSuggestions(
      PLAN,
      buildExplicitColumnRenameSuggestions(PLAN, [{ database: 'app', table: 't', from: 'a', to: 'b', source: 'cli' }]),
      { previous: [], next: [] }
    )
    expect(summary(plan)).toEqual([
      'drop_view view:app.z_top',
      'drop_view view:app.a_base',
      'drop_dictionary dictionary:app.d_old',
      'drop_table table:app.users',
      'create_database database:app',
      'alter_table_rename_column table:app.t:column_rename:a:b',
      'create_table table:app.customers',
      'create_dictionary dictionary:app.d',
      'create_view view:app.z_base',
      'create_view view:app.a_top',
    ])
  })

  // planDiff removes a column's expression in its own operation, with the
  // MODIFY COLUMN's key, and it must still run first once a rename merges the
  // alters: ClickHouse would cast the retained 'abc' to Int64 and fail.
  test('column rename keeps a REMOVE DEFAULT right before its MODIFY COLUMN', () => {
    const t = (columns: ColumnDefinition[]) =>
      table({
        database: 'app',
        name: 't',
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        columns: [{ name: 'id', type: 'UInt64' }, ...columns],
      })
    const previous = [t([{ name: 'a', type: 'String' }, { name: 'code', type: 'String', default: 'abc' }])]
    const next = [t([{ name: 'b', type: 'String' }, { name: 'code', type: 'Int64' }])]
    const planned = planDiff(previous, next)
    const plan = applySelectedRenameSuggestions(
      planned,
      buildExplicitColumnRenameSuggestions(planned, [{ database: 'app', table: 't', from: 'a', to: 'b', source: 'cli' }]),
      { previous, next }
    )
    expect(plan.operations.map((operation) => operation.sql)).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `code` REMOVE DEFAULT;',
      'ALTER TABLE app.t MODIFY COLUMN `code` Int64;',
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;',
    ])
  })

  test('column rename keeps an ADD COLUMN after the ADD COLUMN its DEFAULT reads (#681)', () => {
    const t = (columns: ColumnDefinition[]) =>
      table({
        database: 'app',
        name: 't',
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        columns: [{ name: 'id', type: 'UInt64' }, ...columns],
      })
    const previous = [t([{ name: 'a', type: 'String' }])]
    const next = [
      t([
        { name: 'b', type: 'String' },
        { name: 'price', type: 'UInt64' },
        { name: 'Total', type: 'UInt64', default: { expression: 'price + 1' } },
      ]),
    ]
    const planned = planDiff(previous, next)
    const plan = applySelectedRenameSuggestions(
      planned,
      buildExplicitColumnRenameSuggestions(planned, [{ database: 'app', table: 't', from: 'a', to: 'b', source: 'cli' }]),
      { previous, next }
    )
    expect(plan.operations.map((operation) => operation.sql)).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `price` UInt64;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `Total` UInt64 DEFAULT price + 1;',
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;',
    ])
  })

  // ClickHouse rejects a DROP COLUMN while a skip index, constraint or
  // projection still reads the column; planDiff drops those first (#747).
  test('column rename keeps index, constraint and projection drops before the DROP COLUMN they read', () => {
    const previous = [
      table({
        database: 'app',
        name: 't',
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'a', type: 'String' },
          { name: 'x', type: 'String' },
        ],
        indexes: [{ name: 'idx_x', expression: 'x', type: 'bloom_filter', granularity: 1 }],
        constraints: [{ name: 'c_x', check: "x != ''" }],
        projections: [{ name: 'p_x', query: 'SELECT x ORDER BY x' }],
      }),
    ]
    const next = [
      table({
        database: 'app',
        name: 't',
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'b', type: 'String' },
        ],
      }),
    ]
    const planned = planDiff(previous, next)
    const plan = applySelectedRenameSuggestions(
      planned,
      buildExplicitColumnRenameSuggestions(planned, [{ database: 'app', table: 't', from: 'a', to: 'b', source: 'cli' }]),
      { previous, next }
    )
    expect(plan.operations.map((operation) => operation.sql)).toEqual([
      'ALTER TABLE app.t DROP CONSTRAINT IF EXISTS `c_x`;',
      'ALTER TABLE app.t DROP INDEX IF EXISTS `idx_x`;',
      'ALTER TABLE app.t DROP PROJECTION IF EXISTS `p_x`;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `x`;',
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;',
    ])
  })
})

describe('plan-pipeline orders column statements with the column renames (#746, #758)', () => {
  const t = (columns: ColumnDefinition[]) =>
    table({
      database: 'app',
      name: 't',
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
      columns: [{ name: 'id', type: 'UInt64' }, ...columns],
    })
  const renamed = (previous: SchemaDefinition[], next: SchemaDefinition[], from: string, to: string) => {
    const planned = planDiff(previous, next)
    return applySelectedRenameSuggestions(
      planned,
      buildExplicitColumnRenameSuggestions(planned, [{ database: 'app', table: 't', from, to, source: 'cli' }]),
      { previous, next }
    ).operations.map((operation) => operation.sql)
  }

  test('renames a column before the ADD COLUMNs that read its new name (#746)', () => {
    expect(
      renamed(
        [t([{ name: 'a', type: 'String' }])],
        [
          t([
            { name: 'b', type: 'String' },
            { name: 'Copy', type: 'String', defaultKind: 'MATERIALIZED', default: { expression: "concat(`b`, '!')" } },
            { name: 'a_len', type: 'UInt64', defaultKind: 'ALIAS', default: { expression: 'length(b)' } },
            { name: 'c_plain', type: 'String' },
          ]),
        ],
        'a',
        'b'
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `c_plain` String;',
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;',
      "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `Copy` String MATERIALIZED concat(`b`, '!');",
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a_len` UInt64 ALIAS length(b);',
    ])
  })

  test('renames a column before the MODIFY COLUMN that reads its new name (#758)', () => {
    expect(
      renamed(
        [t([{ name: 'a', type: 'String' }, { name: 'code', type: 'String', default: { expression: 'a' } }])],
        [t([{ name: 'b', type: 'String' }, { name: 'code', type: 'String', default: { expression: 'b' } }])],
        'a',
        'b'
      )
    ).toEqual([
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;',
      'ALTER TABLE app.t MODIFY COLUMN `code` String DEFAULT b;',
    ])
  })

  // Reordering only the ADDs and the RENAME left the MODIFY of `d` in its
  // slot, before the ADD of `c` it reads.
  test('keeps a MODIFY COLUMN after the ADD COLUMN it reads when a rename moves', () => {
    expect(
      renamed(
        [t([{ name: 'a', type: 'UInt64' }, { name: 'd', type: 'UInt64' }])],
        [
          t([
            { name: 'c', type: 'UInt64', default: { expression: "length('abc')" } },
            { name: 'd', type: 'UInt64', default: { expression: 'c + 1' } },
            { name: 'length', type: 'UInt64' },
          ]),
        ],
        'a',
        'length'
      )
    ).toEqual([
      "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `c` UInt64 DEFAULT length('abc');",
      'ALTER TABLE app.t MODIFY COLUMN `d` UInt64 DEFAULT c + 1;',
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `length`;',
    ])
  })

  test('keeps a chain of reads in order around a rename', () => {
    expect(
      renamed(
        [t([{ name: 'a', type: 'UInt64' }, { name: 'd', type: 'UInt64' }])],
        [
          t([
            { name: 'b', type: 'UInt64' },
            { name: 'c', type: 'UInt64', default: { expression: 'b + 1' } },
            { name: 'd', type: 'UInt64', default: { expression: 'c + 1' } },
          ]),
        ],
        'a',
        'b'
      )
    ).toEqual([
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `c` UInt64 DEFAULT b + 1;',
      'ALTER TABLE app.t MODIFY COLUMN `d` UInt64 DEFAULT c + 1;',
    ])
  })

  // A function call named like the new column used to read it, which made a
  // cycle that kept the ADD before the RENAME it reads.
  test('a function call named like a column does not hold back the rename', () => {
    expect(
      renamed(
        [t([{ name: 'a', type: 'UInt64', default: { expression: "length('abc')" } }])],
        [
          t([
            { name: 'b', type: 'UInt64', default: { expression: "length('abc')" } },
            { name: 'length', type: 'UInt64', default: { expression: 'b + 1' } },
          ]),
        ],
        'a',
        'b'
      )
    ).toEqual([
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `length` UInt64 DEFAULT b + 1;',
    ])
  })

  test('keeps a DROP COLUMN after the MODIFY that stops reading it', () => {
    expect(
      renamed(
        [
          t([
            { name: 'a', type: 'UInt64' },
            { name: 'b', type: 'UInt64', default: { expression: 'c' } },
            { name: 'c', type: 'UInt64' },
          ]),
        ],
        [
          t([
            { name: 'b', type: 'UInt64', default: { expression: 'z' } },
            { name: 'y', type: 'UInt64' },
            { name: 'z', type: 'UInt64' },
          ]),
        ],
        'a',
        'y'
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT z;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `c`;',
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `y`;',
    ])
  })

  test('a table rename keeps the planner order of the column statements', () => {
    const next = [t([{ name: 'Total', type: 'UInt64', default: { expression: 'price + 1' } }, { name: 'price', type: 'UInt64' }])]
    const planned = planDiff([t([{ name: 'Total', type: 'UInt64' }])], next)
    const plan = applyExplicitTableRenames(planned, [
      { oldDatabase: 'app', oldName: 'old_t', newDatabase: 'app', newName: 't', source: 'cli' },
    ])
    expect(plan.operations.map((operation) => operation.sql)).toEqual([
      'RENAME TABLE IF EXISTS app.old_t TO app.t;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `price` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `Total` UInt64 DEFAULT price + 1;',
    ])
  })
})

describe('plan-pipeline quotes the database it creates for a cross-database rename (#490)', () => {
  const EMPTY_PLAN: MigrationPlan = { operations: [], riskSummary: { safe: 0, caution: 0, danger: 0 }, renameSuggestions: [] }

  test('table rename', () => {
    const plan = applyExplicitTableRenames(EMPTY_PLAN, [
      { oldDatabase: 'repro', oldName: 't', newDatabase: 'repro-old', newName: 't', source: 'cli' },
    ])
    expect(plan.operations.map((operation) => operation.sql)).toEqual([
      'CREATE DATABASE IF NOT EXISTS `repro-old`;',
      'RENAME TABLE IF EXISTS repro.t TO `repro-old`.t;',
    ])
  })

  test('dictionary rename', () => {
    const plan = applyExplicitDictionaryRenames(EMPTY_PLAN, [
      { oldDatabase: 'repro', oldName: 'd', newDatabase: 'repro-old', newName: 'd', source: 'cli' },
    ])
    expect(plan.operations.map((operation) => operation.sql)).toEqual([
      'CREATE DATABASE IF NOT EXISTS `repro-old`;',
      'RENAME DICTIONARY IF EXISTS repro.d TO `repro-old`.d;',
    ])
  })
})
