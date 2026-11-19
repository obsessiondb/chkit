import { describe, expect, test } from 'bun:test'

import { planDiff, table } from './index'

// #789: ordering the MODIFY COLUMNs of a deep chain of defaults took time
// quadratic in its length: 25 s and more here. Now it takes about a second.
const depth = 3000
const timeout = 10_000

const chainTable = (expression: (index: number) => string, extra: string[] = []) =>
  table({
    database: 'app',
    name: 'chain',
    columns: [
      { name: 'id', type: 'UInt64' },
      ...Array.from({ length: depth }, (_, index) => ({
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
const next = (index: number) => (index + 1 < depth ? `c${index + 1}` : 'id')
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
