import { describe, expect, test } from 'bun:test'

import { planDiff, table, type ColumnDefinition } from '@chkit/core'

import {
  applySelectedRenameSuggestions,
  buildExplicitColumnRenameSuggestions,
} from '../../../commands/generate/plan-pipeline.js'

const t = (columns: ColumnDefinition[]) =>
  table({
    database: 'app',
    name: 't',
    engine: 'MergeTree()',
    primaryKey: ['id'],
    orderBy: ['id'],
    columns: [{ name: 'id', type: 'UInt64' }, ...columns],
  })

describe('column renames whose keys collide (#801)', () => {
  // Renames `a:b` → `c` and `a` → `b:c` both give the operation key
  // `table:app.t:column_rename:a:b:c`.
  test('a DEFAULT that reads a renamed column runs after the rename to it', () => {
    const previous = [
      t([
        { name: 'a:b', type: 'UInt64' },
        { name: 'a', type: 'UInt64' },
        { name: 'x', type: 'UInt64', default: 0 },
      ]),
    ]
    const next = [
      t([
        { name: 'c', type: 'UInt64' },
        { name: 'b:c', type: 'UInt64' },
        { name: 'x', type: 'UInt64', default: { expression: 'c + 1' } },
      ]),
    ]
    const planned = planDiff(previous, next)
    const plan = applySelectedRenameSuggestions(
      planned,
      buildExplicitColumnRenameSuggestions(planned, [
        { database: 'app', table: 't', from: 'a:b', to: 'c', source: 'cli' },
        { database: 'app', table: 't', from: 'a', to: 'b:c', source: 'cli' },
      ]),
      { previous, next }
    )

    expect(plan.operations.map((operation) => operation.sql)).toEqual([
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a:b` TO `c`;',
      'ALTER TABLE app.t MODIFY COLUMN `x` UInt64 DEFAULT c + 1;',
      'ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b:c`;',
    ])
  })
})
