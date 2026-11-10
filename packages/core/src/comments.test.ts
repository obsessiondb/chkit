import { describe, expect, test } from 'bun:test'

import { dictionary, materializedView, table, view } from './model.js'
import { planDiff } from './planner.js'
import { toCreateSQL } from './sql.js'
import type { ColumnDefinition, SchemaDefinition } from './model.js'

// #464: chkit-py's tests/test_comments.py asserts the same SQL for the same input.

// Each value, and the string literal ClickHouse must receive to store it as is.
const EDGE_COMMENTS: Array<[string, string]> = [
  [`it's "q"`, `'it''s "q"'`],
  ['a\\b C:\\new\\t', "'a\\\\b C:\\\\new\\\\t'"],
  ['trail\\', "'trail\\\\'"],
  ['l1\nl2', "'l1\nl2'"],
  ['héllo 世界 🚀', "'héllo 世界 🚀'"],
  ['x AS y', "'x AS y'"],
]

function events(input: { comment?: string; columns?: ColumnDefinition[] } = {}) {
  return table({
    database: 'app',
    name: 'events',
    engine: 'MergeTree()',
    columns: input.columns ?? [{ name: 'id', type: 'UInt64' }],
    primaryKey: ['id'],
    orderBy: ['id'],
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  })
}

function objects(comment?: string): SchemaDefinition[] {
  const withComment = comment === undefined ? {} : { comment }
  return [
    events(withComment),
    view({ database: 'app', name: 'v', as: 'SELECT id FROM app.events', ...withComment }),
    materializedView({
      database: 'app',
      name: 'mv',
      to: { database: 'app', name: 'events' },
      as: 'SELECT id FROM app.src',
      ...withComment,
    }),
    dictionary({
      database: 'app',
      name: 'd',
      attributes: [{ name: 'id', type: 'UInt64' }],
      primaryKey: ['id'],
      source: 'NULL()',
      layout: 'HASHED()',
      lifetime: '300',
      ...withComment,
    }),
  ]
}

function sqlOf(oldDefinitions: SchemaDefinition[], newDefinitions: SchemaDefinition[]): string[] {
  return planDiff(oldDefinitions, newDefinitions).operations.map((op) => op.sql)
}

describe('@chkit/core comments (#464)', () => {
  for (const [comment, literal] of EDGE_COMMENTS) {
    test(`CREATE escapes ${JSON.stringify(comment)} for every object kind and columns`, () => {
      const column = { name: 'id', type: 'UInt64', comment }
      const [tableDef, viewDef, mvDef, dictDef] = objects(comment) as [
        SchemaDefinition,
        SchemaDefinition,
        SchemaDefinition,
        SchemaDefinition,
      ]
      expect(toCreateSQL(events({ comment, columns: [column] }))).toBe(
        `CREATE TABLE IF NOT EXISTS app.events\n(\n  \`id\` UInt64 COMMENT ${literal}\n) ENGINE = MergeTree()\nPRIMARY KEY (\`id\`)\nORDER BY (\`id\`)\nCOMMENT ${literal};`
      )
      expect(toCreateSQL(viewDef)).toBe(`CREATE VIEW IF NOT EXISTS app.v COMMENT ${literal} AS\nSELECT id FROM app.events;`)
      expect(toCreateSQL(mvDef)).toBe(
        `CREATE MATERIALIZED VIEW IF NOT EXISTS app.mv TO app.events COMMENT ${literal} AS\nSELECT id FROM app.src;`
      )
      expect(toCreateSQL(dictDef)).toEndWith(`LIFETIME(300)\nCOMMENT ${literal};`)
      expect(toCreateSQL(tableDef)).toEndWith(`COMMENT ${literal};`)
    })

    test(`a change to ${JSON.stringify(comment)} alters every object in place`, () => {
      expect(sqlOf(objects('old'), objects(comment))).toEqual([
        `ALTER TABLE app.d MODIFY COMMENT ${literal};`,
        `ALTER TABLE app.mv MODIFY COMMENT ${literal};`,
        `ALTER TABLE app.events MODIFY COMMENT ${literal};`,
        `ALTER TABLE app.v MODIFY COMMENT ${literal};`,
      ])
    })
  }

  test('adding and removing an object comment is MODIFY COMMENT, at safe risk', () => {
    const added = planDiff(objects(), objects('c'))
    expect(added.operations.map((op) => [op.type, op.key, op.risk])).toEqual([
      ['alter_table_modify_comment', 'dictionary:app.d:comment', 'safe'],
      ['alter_table_modify_comment', 'materialized_view:app.mv:comment', 'safe'],
      ['alter_table_modify_comment', 'table:app.events:comment', 'safe'],
      ['alter_table_modify_comment', 'view:app.v:comment', 'safe'],
    ])
    expect(sqlOf(objects('c'), objects())).toEqual([
      "ALTER TABLE app.d MODIFY COMMENT '';",
      "ALTER TABLE app.mv MODIFY COMMENT '';",
      "ALTER TABLE app.events MODIFY COMMENT '';",
      "ALTER TABLE app.v MODIFY COMMENT '';",
    ])
  })

  test("an empty comment is no comment: '' and absent plan nothing", () => {
    const column = (comment?: string): ColumnDefinition[] => [
      { name: 'id', type: 'UInt64', ...(comment === undefined ? {} : { comment }) },
    ]
    const withEmpty = [events({ comment: '', columns: column('') }), ...objects('').slice(1)]
    const without = [events({ columns: column() }), ...objects().slice(1)]
    expect(sqlOf(without, withEmpty)).toEqual([])
    expect(sqlOf(withEmpty, without)).toEqual([])
  })

  test('a change that recreates the object carries the new comment in its CREATE', () => {
    const [oldView] = objects('old').slice(1, 2) as [SchemaDefinition]
    const newView = view({ database: 'app', name: 'v', as: 'SELECT id + 1 AS id FROM app.events', comment: 'new' })
    expect(sqlOf([oldView], [newView])).toEqual([
      'DROP VIEW IF EXISTS app.v;',
      "CREATE VIEW IF NOT EXISTS app.v COMMENT 'new' AS\nSELECT id + 1 AS id FROM app.events;",
    ])
  })

  test('a dictionary comment change does not replace the dictionary', () => {
    const [, , , oldDict] = objects('old') as SchemaDefinition[]
    const [, , , newDict] = objects('new') as SchemaDefinition[]
    expect(sqlOf([oldDict as SchemaDefinition], [newDict as SchemaDefinition])).toEqual([
      "ALTER TABLE app.d MODIFY COMMENT 'new';",
    ])
  })

  test('a materialized view refresh and comment change are two ALTERs, no recreate', () => {
    const mv = (every: string, comment: string) =>
      materializedView({
        database: 'app',
        name: 'rmv',
        to: { database: 'app', name: 'events' },
        refresh: { every },
        as: 'SELECT id FROM app.src',
        comment,
      })
    expect(sqlOf([mv('1 HOUR', 'old')], [mv('2 HOUR', 'new')])).toEqual([
      "ALTER TABLE app.rmv MODIFY COMMENT 'new';",
      'ALTER TABLE app.rmv MODIFY REFRESH EVERY 2 HOUR;',
    ])
  })

  describe('columns', () => {
    const plan = (oldColumn: ColumnDefinition, newColumn: ColumnDefinition) =>
      planDiff([events({ columns: [oldColumn] })], [events({ columns: [newColumn] })]).operations.map((op) => [
        op.type,
        op.risk,
        op.sql,
      ])

    test('adding or changing only the comment is COMMENT COLUMN', () => {
      expect(plan({ name: 'id', type: 'UInt64' }, { name: 'id', type: 'UInt64', comment: 'trail\\' })).toEqual([
        ['alter_table_modify_column', 'safe', "ALTER TABLE app.events COMMENT COLUMN `id` 'trail\\\\';"],
      ])
      expect(
        plan({ name: 'id', type: 'UInt64', comment: 'old' }, { name: 'id', type: 'UInt64', comment: "it's" })
      ).toEqual([['alter_table_modify_column', 'safe', "ALTER TABLE app.events COMMENT COLUMN `id` 'it''s';"]])
    })

    test('a comment change on a column whose fields are reordered is COMMENT COLUMN (#523)', () => {
      const commentOnly = [['alter_table_modify_column', 'safe', "ALTER TABLE app.events COMMENT COLUMN `id` 'new';"]]
      expect(
        plan(
          { name: 'id', type: 'UInt64', comment: 'old', default: 7, defaultKind: 'DEFAULT', nullable: false },
          { nullable: false, defaultKind: 'DEFAULT', default: 7, comment: 'new', type: 'UInt64', name: 'id' }
        )
      ).toEqual(commentOnly)
      // A field the DSL does not type (e.g. from a JavaScript schema file) is
      // compared too, so its key order must not matter either.
      expect(
        plan(
          { name: 'id', type: 'UInt64', comment: 'old', a: 1, b: 2 } as ColumnDefinition,
          { b: 2, a: 1, comment: 'new', type: 'UInt64', name: 'id' } as ColumnDefinition
        )
      ).toEqual(commentOnly)
    })

    test('removing only the comment is REMOVE COMMENT', () => {
      expect(plan({ name: 'id', type: 'UInt64', comment: 'old' }, { name: 'id', type: 'UInt64' })).toEqual([
        ['alter_table_modify_column', 'safe', 'ALTER TABLE app.events MODIFY COLUMN `id` REMOVE COMMENT;'],
      ])
    })

    test('a type change keeps MODIFY COLUMN with the new comment', () => {
      expect(
        plan({ name: 'id', type: 'UInt32', comment: 'old' }, { name: 'id', type: 'UInt64', comment: 'new' })
      ).toEqual([['alter_table_modify_column', 'caution', "ALTER TABLE app.events MODIFY COLUMN `id` UInt64 COMMENT 'new';"]])
    })

    test('a type change that removes the comment runs REMOVE COMMENT first', () => {
      expect(plan({ name: 'id', type: 'UInt32', comment: 'old' }, { name: 'id', type: 'UInt64' })).toEqual([
        ['alter_table_modify_column', 'safe', 'ALTER TABLE app.events MODIFY COLUMN `id` REMOVE COMMENT;'],
        ['alter_table_modify_column', 'caution', 'ALTER TABLE app.events MODIFY COLUMN `id` UInt64;'],
      ])
    })
  })

  test('comment ALTERs quote table and column names that need it', () => {
    const quoted = (input: { comment?: string; columnComment?: string }) =>
      table({
        database: 'app',
        name: 'events-v2',
        engine: 'MergeTree()',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'my col', type: 'String', ...(input.columnComment === undefined ? {} : { comment: input.columnComment }) },
        ],
        primaryKey: ['id'],
        orderBy: ['id'],
        ...(input.comment === undefined ? {} : { comment: input.comment }),
      })
    expect(sqlOf([quoted({ columnComment: 'old' })], [quoted({ comment: 't', columnComment: 'new' })])).toEqual([
      "ALTER TABLE app.`events-v2` COMMENT COLUMN `my col` 'new';",
      "ALTER TABLE app.`events-v2` MODIFY COMMENT 't';",
    ])
    expect(sqlOf([quoted({ columnComment: 'old' })], [quoted({})])).toEqual([
      'ALTER TABLE app.`events-v2` MODIFY COLUMN `my col` REMOVE COMMENT;',
    ])
  })
})
