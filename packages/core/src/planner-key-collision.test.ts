import { describe, expect, test } from 'bun:test'

import { planDiff, table } from './index'
import type { ColumnDefinition } from './index'

const appTable = (name: string, columns: ColumnDefinition[]) =>
  table({ database: 'app', name, columns, engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] })
const id: ColumnDefinition = { name: 'id', type: 'UInt64' }

function sqlOf(oldDefs: Parameters<typeof planDiff>[0], newDefs: Parameters<typeof planDiff>[1]): string[] {
  return planDiff(oldDefs, newDefs).operations.map((op) => op.sql)
}

// Table `t:column:x` with column `a` and table `t` with column `x:column:a`
// both give the operation key `table:app.t:column:x:column:a` (#801).
describe('planDiff orders column statements of tables whose keys collide (#801)', () => {
  test('issue repro: the other table does not hide what a changed expression reads', () => {
    const other = appTable('t:column:x', [id, { name: 'a', type: 'UInt64', default: 'fn:id + 0' }])
    const before = appTable('t', [id, { name: 'x:column:a', type: 'UInt64', default: 'fn:id + 0' }])
    const after = appTable('t', [
      id,
      { name: 'x:column:a', type: 'UInt64', default: 'fn:`x:column:b` + 1' },
      { name: 'x:column:b', type: 'UInt64', default: 'fn:id + 2' },
    ])

    const expected = [
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `x:column:b` UInt64 DEFAULT id + 2;',
      'ALTER TABLE app.t MODIFY COLUMN `x:column:a` UInt64 DEFAULT `x:column:b` + 1;',
    ]
    expect(sqlOf([before], [after])).toEqual(expected)
    expect(sqlOf([before, other], [after, other])).toEqual(expected)
  })

  test('a statement of the other table does not hide that the cycle-closing MODIFY is last', () => {
    // `x:column:a` reads `x:column:b`, whose old expression reads it back:
    // the MODIFY of `x:column:b` must remove that read first (#769).
    const before = [
      appTable('t', [
        id,
        { name: 'x:column:a', type: 'UInt64', default: 'fn:id + 0' },
        { name: 'x:column:b', type: 'UInt64', default: 'fn:`x:column:a` + 1' },
      ]),
      appTable('t:column:x', [id, { name: 'a', type: 'UInt64', comment: 'old' }]),
    ]
    const after = [
      appTable('t', [
        id,
        { name: 'x:column:a', type: 'UInt64', default: 'fn:`x:column:b` + 1' },
        { name: 'x:column:b', type: 'UInt64', default: 'fn:id + 2' },
      ]),
      appTable('t:column:x', [id, { name: 'a', type: 'UInt64', comment: 'new' }]),
    ]

    expect(sqlOf(before, after)).toEqual([
      "ALTER TABLE app.`t:column:x` COMMENT COLUMN `a` 'new';",
      'ALTER TABLE app.t MODIFY COLUMN `x:column:b` UInt64 DEFAULT id + 2;',
      'ALTER TABLE app.t MODIFY COLUMN `x:column:a` UInt64 DEFAULT `x:column:b` + 1;',
    ])
  })
})
