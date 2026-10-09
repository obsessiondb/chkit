import { describe, expect, test } from 'bun:test'

import type { MigrationPlan, TableDefinition } from './model-types.js'
import { materializedView, table } from './model.js'
import { applyOnClusterToPlan } from './on-cluster.js'
import { planDiff } from './planner.js'
import {
  renderAlterAddColumn,
  renderAlterDropColumn,
  renderAlterDropIndex,
  renderAlterDropProjection,
  renderAlterRemoveCodec,
  toCreateSQL,
} from './sql.js'
import { unquoteIdentifiers } from './identifier.js'
import { validateDefinitions } from './validate.js'

// Names a source catalog (e.g. Postgres, via CDC) can legally contain but that
// break or change the meaning of unescaped ClickHouse SQL.
function eventsTable(overrides: Partial<TableDefinition> = {}): TableDefinition {
  return table({
    database: 'app',
    name: 'events',
    columns: [{ name: 'id', type: 'UInt64' }],
    engine: 'MergeTree()',
    primaryKey: ['id'],
    orderBy: ['id'],
    ...overrides,
  })
}

describe('identifier rendering stays backward compatible', () => {
  test('plain database, table and column names render exactly as before', () => {
    expect(toCreateSQL(eventsTable())).toBe(
      'CREATE TABLE IF NOT EXISTS app.events\n(\n  `id` UInt64\n) ENGINE = MergeTree()\nPRIMARY KEY (`id`)\nORDER BY (`id`);'
    )
  })

  test('plain names in DROP statements render exactly as before', () => {
    const plan = planDiff([eventsTable()], [])
    expect(plan.operations.map((op) => op.sql)).toEqual(['DROP TABLE IF EXISTS app.events;'])
  })
})

describe('database and table names are quoted when needed', () => {
  test('a table name containing a dot stays a single identifier', () => {
    expect(toCreateSQL(eventsTable({ name: 'a.b' }))).toStartWith(
      'CREATE TABLE IF NOT EXISTS app.`a.b`\n'
    )
  })

  test('a database name with a hyphen is quoted', () => {
    expect(toCreateSQL(eventsTable({ database: 'my-db' }))).toStartWith(
      'CREATE TABLE IF NOT EXISTS `my-db`.events\n'
    )
  })

  test('a backtick inside a table name is escaped', () => {
    expect(toCreateSQL(eventsTable({ name: 'weird`name' }))).toStartWith(
      'CREATE TABLE IF NOT EXISTS app.`weird\\`name`\n'
    )
  })

  test('a backslash inside a table name is escaped', () => {
    expect(toCreateSQL(eventsTable({ name: 'a\\b' }))).toStartWith(
      'CREATE TABLE IF NOT EXISTS app.`a\\\\b`\n'
    )
  })

  test('ALTER statements quote the table reference', () => {
    const def = eventsTable({ name: 'a b' })
    expect(renderAlterAddColumn(def, { name: 'x', type: 'String' })).toBe(
      'ALTER TABLE app.`a b` ADD COLUMN IF NOT EXISTS `x` String;'
    )
  })

  test('DROP statements from the planner quote the table reference', () => {
    const plan = planDiff([eventsTable({ name: 'a;b' })], [])
    expect(plan.operations.map((op) => op.sql)).toEqual(['DROP TABLE IF EXISTS app.`a;b`;'])
  })

  test('CREATE DATABASE quotes the database name', () => {
    const plan = planDiff([], [eventsTable({ database: 'my-db' })])
    expect(plan.operations[0]?.sql).toBe('CREATE DATABASE IF NOT EXISTS `my-db`;')
  })

  test('materialized view TO target is quoted', () => {
    const mv = materializedView({
      database: 'app',
      name: 'mv.events',
      to: { database: 'app', name: 'events-agg' },
      as: 'SELECT 1',
    })
    expect(toCreateSQL(mv)).toBe(
      'CREATE MATERIALIZED VIEW IF NOT EXISTS app.`mv.events` TO app.`events-agg` AS\nSELECT 1;'
    )
  })
})

describe('column, index and projection names are escaped', () => {
  test('a backtick inside a column name cannot close the quoted identifier', () => {
    const def = eventsTable({
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'evil` UInt8, `x', type: 'String' },
      ],
    })
    expect(toCreateSQL(def)).toContain('  `evil\\` UInt8, \\`x` String')
  })

  test('key clauses escape column names that contain backticks', () => {
    const def = eventsTable({
      columns: [{ name: 'a`b', type: 'UInt64' }],
      primaryKey: ['a`b'],
      orderBy: ['a`b'],
    })
    expect(toCreateSQL(def)).toContain('ORDER BY (`a\\`b`)')
  })

  test('DROP COLUMN, REMOVE CODEC, DROP INDEX and DROP PROJECTION escape names', () => {
    const def = eventsTable()
    expect(renderAlterDropColumn(def, 'c`d')).toBe('ALTER TABLE app.events DROP COLUMN IF EXISTS `c\\`d`;')
    expect(renderAlterRemoveCodec(def, 'c`d')).toBe(
      'ALTER TABLE app.events MODIFY COLUMN `c\\`d` REMOVE CODEC;'
    )
    expect(renderAlterDropIndex(def, 'i`x')).toBe('ALTER TABLE app.events DROP INDEX IF EXISTS `i\\`x`;')
    expect(renderAlterDropProjection(def, 'p`x')).toBe(
      'ALTER TABLE app.events DROP PROJECTION IF EXISTS `p\\`x`;'
    )
  })

  test('rename-column confirmation SQL escapes both column names', () => {
    const oldDef = eventsTable({
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'old`name', type: 'String' },
      ],
    })
    const newDef = eventsTable({
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'new`name', type: 'String' },
      ],
    })
    const plan = planDiff([oldDef], [newDef])
    expect(plan.renameSuggestions.map((s) => s.confirmationSQL)).toEqual([
      'ALTER TABLE app.events RENAME COLUMN IF EXISTS `old\\`name` TO `new\\`name`;',
    ])
  })
})

describe('ON CLUSTER injection handles quoted object references', () => {
  test('places the clause after a quoted name that contains a space', () => {
    const plan: MigrationPlan = {
      operations: [
        { type: 'drop_table', key: 'k', risk: 'danger', sql: 'DROP TABLE IF EXISTS `my db`.`a b`;' },
        {
          type: 'alter_table_add_column',
          key: 'k',
          risk: 'safe',
          sql: 'ALTER TABLE app.`a\\` b` ADD COLUMN IF NOT EXISTS `x` String;',
        },
      ],
      riskSummary: { safe: 0, caution: 0, danger: 0 },
      renameSuggestions: [],
    }
    expect(applyOnClusterToPlan(plan, 'c').operations.map((op) => op.sql)).toEqual([
      "DROP TABLE IF EXISTS `my db`.`a b` ON CLUSTER 'c';",
      "ALTER TABLE app.`a\\` b` ON CLUSTER 'c' ADD COLUMN IF NOT EXISTS `x` String;",
    ])
  })
})

describe('validateDefinitions rejects unusable identifiers', () => {
  test('rejects an empty table name', () => {
    const issues = validateDefinitions([eventsTable({ name: '' })])
    expect(issues.map((i) => i.code)).toContain('invalid_identifier')
  })

  test('rejects an empty database name', () => {
    const issues = validateDefinitions([eventsTable({ database: '' })])
    expect(issues.map((i) => i.code)).toContain('invalid_identifier')
  })

  test('rejects a column name containing a NUL byte', () => {
    const issues = validateDefinitions([
      eventsTable({
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'a\u0000b', type: 'String' },
        ],
      }),
    ])
    expect(issues.map((i) => i.code)).toEqual(['invalid_identifier'])
  })

  test('rejects a table name containing a newline', () => {
    const issues = validateDefinitions([eventsTable({ name: 'a\nb' })])
    expect(issues.map((i) => i.code)).toEqual(['invalid_identifier'])
  })

  test('rejects index and projection names with control characters', () => {
    const issues = validateDefinitions([
      eventsTable({
        indexes: [{ name: 'i\tx', expression: 'id', type: 'minmax', granularity: 1 }],
        projections: [{ name: 'p\rx', query: 'SELECT id ORDER BY id' }],
      }),
    ])
    expect(issues.map((i) => i.code)).toEqual(['invalid_identifier', 'invalid_identifier'])
  })

  test('accepts names that only need quoting', () => {
    const issues = validateDefinitions([
      eventsTable({
        database: 'my-db',
        name: 'a.b c`d',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'weird`name', type: 'String' },
          { name: 'ünïcødé', type: 'String' },
        ],
      }),
    ])
    expect(issues).toEqual([])
  })
})

describe('key clauses keep declared column names whole', () => {
  test('a declared column name containing a comma is not split', () => {
    const def = eventsTable({
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'e,f)', type: 'UInt8' },
      ],
      orderBy: ['id', 'e,f)'],
    })
    expect(validateDefinitions([def])).toEqual([])
    expect(toCreateSQL(def)).toContain('ORDER BY (`id`, `e,f)`)')
  })

  test('an identical definition with a comma column plans no changes', () => {
    const def = eventsTable({
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'e,f)', type: 'UInt8' },
      ],
      orderBy: ['id', 'e,f)'],
    })
    expect(planDiff([def], [def]).operations).toEqual([])
  })

  test('a comma-separated expression entry is still split', () => {
    const def = eventsTable({
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime' },
      ],
      orderBy: ['id, toDate(ts)'],
    })
    expect(toCreateSQL(def)).toContain('ORDER BY (`id`, toDate(ts))')
  })
})

describe('unquoteIdentifiers', () => {
  test('unescapes every backtick-quoted identifier', () => {
    expect(unquoteIdentifiers('(id, `a b`, `c\\`d`, `e,f)`, `x\\\\y`, `g``h`)')).toBe(
      '(id, a b, c`d, e,f), x\\y, g`h)'
    )
  })

  test('leaves string literals untouched', () => {
    expect(unquoteIdentifiers("concat(`a b`, '`not an identifier`')")).toBe(
      "concat(a b, '`not an identifier`')"
    )
  })
})
