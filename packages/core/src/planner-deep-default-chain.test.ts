import { describe, expect, test } from 'bun:test'

import { planDiff, table } from './index'

// #789: ordering the MODIFY COLUMNs of a deep chain of defaults took time
// quadratic in its length: 20 s and more here. Now it takes a second or two.
const depth = 8000
const timeout = 10_000

const chainTable = (expression: (index: number) => string, extra: string[] = [], length = depth) =>
  table({
    database: 'app',
    name: 'chain',
    columns: [
      { name: 'id', type: 'UInt64' },
      ...Array.from({ length }, (_, index) => ({
        name: `c${index}`,
        type: 'UInt64',
        default: { expression: expression(index) },
      })),
      ...extra.map((name) => ({ name, type: 'UInt64' })),
    ],
    engine: 'MergeTree()',
    primaryKey: ['id'],
    orderBy: ['id'],
  })
const next = (index: number, length = depth) => (index + 1 < length ? `c${index + 1}` : 'id')
const modifyIndex = (sql: string[], column: string) =>
  sql.findIndex((statement) => statement.startsWith(`ALTER TABLE app.chain MODIFY COLUMN \`${column}\` `))

describe('deep chains of defaults', () => {
  test(
    'a chain whose last column stops reading the first is ordered in linear time',
    () => {
      // c0 starts to read c1, and c1 leads to the last column, which stops
      // reading c0: that MODIFY must run first, or c0's closes a cycle.
      const last = `c${depth - 1}`
      const before = chainTable((index) => (index === 0 ? 'id + 0' : index === depth - 1 ? 'id + c0' : `${next(index)} + 0`))
      const after = chainTable((index) => (index === 0 ? 'c1 + 1' : `${next(index)} + 1`))
      const sql = planDiff([before], [after]).operations.map((op) => op.sql)
      expect(sql).toHaveLength(depth)
      expect(modifyIndex(sql, last)).toBeGreaterThanOrEqual(0)
      expect(modifyIndex(sql, last)).toBeLessThan(modifyIndex(sql, 'c0'))
    },
    timeout
  )

  test('a chain whose every column stops reading a column further down is ordered', () => {
    // Each column stops reading the one after next; only the last column's
    // MODIFY, which stops reading c0, must run before c0's.
    const length = 1000
    const before = chainTable(
      (index) =>
        index === 0
          ? 'id'
          : index === length - 1
            ? 'c0'
            : index === length - 2
              ? `c${index + 1} + 0`
              : `c${index + 1} + c${index + 2}`,
      [],
      length
    )
    const after = chainTable((index) => next(index, length), [], length)
    const sql = planDiff([before], [after]).operations.map((op) => op.sql)
    expect(sql).toHaveLength(length)
    expect(modifyIndex(sql, `c${length - 1}`)).toBeGreaterThanOrEqual(0)
    expect(modifyIndex(sql, `c${length - 1}`)).toBeLessThan(modifyIndex(sql, 'c0'))
  })

  test(
    'a chain whose every column stops reading another column is ordered in linear time',
    () => {
      const before = chainTable((index) => `${next(index)} + x`, ['x'])
      const after = chainTable((index) => next(index), ['x'])
      const sql = planDiff([before], [after]).operations.map((op) => op.sql)
      expect(sql).toHaveLength(depth)
      expect(sql[0]).toBe(`ALTER TABLE app.chain MODIFY COLUMN \`c0\` UInt64 DEFAULT c1;`)
    },
    timeout
  )
})
