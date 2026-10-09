import { describe, expect, test } from 'bun:test'

import { planDiff, table, type ColumnDefinition, type MigrationOperation, type MigrationPlan } from '@chkit/core'

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
      buildExplicitColumnRenameSuggestions(PLAN, [{ database: 'app', table: 't', from: 'a', to: 'b', source: 'cli' }])
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
    const planned = planDiff(
      [t([{ name: 'a', type: 'String' }, { name: 'code', type: 'String', default: 'abc' }])],
      [t([{ name: 'b', type: 'String' }, { name: 'code', type: 'Int64' }])]
    )
    const plan = applySelectedRenameSuggestions(
      planned,
      buildExplicitColumnRenameSuggestions(planned, [{ database: 'app', table: 't', from: 'a', to: 'b', source: 'cli' }])
    )
    expect(plan.operations.map((operation) => operation.sql)).toEqual([
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;',
      'ALTER TABLE app.t MODIFY COLUMN `code` REMOVE DEFAULT;',
      'ALTER TABLE app.t MODIFY COLUMN `code` Int64;',
    ])
  })
})
