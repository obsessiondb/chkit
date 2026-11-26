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

  // `a` of `t:column:x` and `x:column:a` of `t` both change from String to
  // UInt64. In `t:column:x`, `b` stops reading `a`, so its MODIFY runs first;
  // in `t`, `x:column:b` starts reading `x:column:a`, so its MODIFY runs
  // after. The colliding keys don't mix the two tables' orders (#814).
  test('each table orders its own type change', () => {
    const otherBefore = appTable('t:column:x', [id, { name: 'a', type: 'String' }, { name: 'b', type: 'UInt64', default: 'fn:length(a)' }])
    const otherAfter = appTable('t:column:x', [id, { name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: 'fn:0' }])
    const ownBefore = appTable('t', [id, { name: 'x:column:a', type: 'String' }, { name: 'x:column:b', type: 'UInt64', default: 'fn:0' }])
    const ownAfter = appTable('t', [
      id,
      { name: 'x:column:a', type: 'UInt64' },
      { name: 'x:column:b', type: 'UInt64', default: 'fn:`x:column:a` + 1' },
    ])
    const other = [
      'ALTER TABLE app.`t:column:x` MODIFY COLUMN `b` UInt64 DEFAULT 0;',
      'ALTER TABLE app.`t:column:x` MODIFY COLUMN `a` UInt64;',
    ]
    const own = [
      'ALTER TABLE app.t MODIFY COLUMN `x:column:a` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `x:column:b` UInt64 DEFAULT `x:column:a` + 1;',
    ]
    expect(sqlOf([otherBefore], [otherAfter])).toEqual(other)
    expect(sqlOf([ownBefore], [ownAfter])).toEqual(own)
    expect(sqlOf([otherBefore, ownBefore], [otherAfter, ownAfter])).toEqual([...own, ...other])
  })
})
