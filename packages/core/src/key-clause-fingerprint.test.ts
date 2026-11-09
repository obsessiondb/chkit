import { describe, expect, test } from 'bun:test'

import { keyClauseFingerprint, planDiff, splitTopLevelComma, table } from './index.js'

// A key over columns `a` and `b` is not a key over one column named `a, b`,
// although the old comparison joined the parts with commas and dropped every
// backtick and space (#558).

const columns = [
  { name: 'id', type: 'UInt64' },
  { name: 'a', type: 'String' },
  { name: 'b', type: 'String' },
  { name: 'a, b', type: 'String' },
  { name: 'a b', type: 'String' },
  { name: 'ab', type: 'String' },
]

function events(orderBy: string[], primaryKey: string[] = orderBy) {
  return table({ database: 'app', name: 'events', engine: 'MergeTree()', columns, orderBy, primaryKey })
}

function planTypes(from: string[], to: string[]): string[] {
  return planDiff([events(from)], [events(to)]).operations.map((op) => op.type)
}

describe('@chkit/core key clause fingerprint', () => {
  test('a quoted name keeps its commas and spaces', () => {
    expect(keyClauseFingerprint('`id`, `a, b`')).not.toBe(keyClauseFingerprint('`id`, `a`, `b`'))
    expect(keyClauseFingerprint('`a b`')).not.toBe(keyClauseFingerprint('`ab`'))
    expect(keyClauseFingerprint('a b')).not.toBe(keyClauseFingerprint('ab'))
  })

  test('whitespace, comments and identifier quoting carry no meaning', () => {
    const fingerprint = keyClauseFingerprint('`id`, toStartOfHour(`ts`), `a, b`')
    expect(keyClauseFingerprint('id,toStartOfHour( ts ),`a, b`')).toBe(fingerprint)
    expect(keyClauseFingerprint('"id" ,\ttoStartOfHour(ts) /* c */, "a, b"')).toBe(fingerprint)
    expect(keyClauseFingerprint('id,\u00a0toStartOfHour(ts), `a, b`')).toBe(fingerprint)
  })

  test('a string literal keeps its exact text', () => {
    expect(keyClauseFingerprint("concat(a, 'x y')")).not.toBe(keyClauseFingerprint("concat(a, 'xy')"))
    expect(keyClauseFingerprint("concat(a, 'x, y')")).not.toBe(keyClauseFingerprint("concat(a, 'x', 'y')"))
  })

  test('escaped quotes and backslashes in a name stay unambiguous', () => {
    expect(keyClauseFingerprint('`c\\`d`')).toBe(keyClauseFingerprint('`c``d`'))
    expect(keyClauseFingerprint('`c\\`d`')).not.toBe(keyClauseFingerprint('`c`, `d`'))
    expect(keyClauseFingerprint('`x\\\\`')).not.toBe(keyClauseFingerprint('`x`'))
  })
})

describe('@chkit/core planner: key parts that collide when joined (#558)', () => {
  test('separate columns a, b and one column named `a, b` recreate the table', () => {
    expect(planTypes(['id', 'a', 'b'], ['id', 'a, b'])).toEqual(['drop_table', 'create_table'])
    expect(planTypes(['id', 'a, b'], ['id', 'a', 'b'])).toEqual(['drop_table', 'create_table'])
  })

  test('a column named `a b` and a column named ab recreate the table', () => {
    expect(planTypes(['id', 'a b'], ['id', 'ab'])).toEqual(['drop_table', 'create_table'])
  })

  test('reordered keys that read the same once joined recreate the table', () => {
    // Joined, both sorting keys used to read `id,a,b,a,b`.
    const plan = planDiff([events(['id', 'a', 'b', 'a, b'], ['id', 'a', 'b'])], [events(['id', 'a, b', 'a', 'b'], ['id', 'a, b'])])
    expect(plan.operations.map((op) => op.type)).toEqual(['drop_table', 'create_table'])
  })

  test('an expression split across entries plans nothing', () => {
    expect(planTypes(['id', 'cityHash64(a', 'b)'], ['id', 'cityHash64(a, b)'])).toEqual([])
    expect(planTypes(['id, cityHash64(a,b)'], ['id', 'cityHash64(a, b)'])).toEqual([])
  })

  test('whitespace and identifier quoting plan nothing', () => {
    expect(planTypes(['id', 'a, b', 'toStartOfHour(  id )'], ['`id`', '`a, b`', 'toStartOfHour(`id`)'])).toEqual([])
    expect(planTypes(['id', 'a b'], ['"id"', '"a b"'])).toEqual([])
  })

  test('the key ClickHouse reports, split as pull splits it, plans nothing', () => {
    // system.tables.sorting_key for ORDER BY (`id`, `a, b`, `a b`, cityHash64(a,b)).
    const pulled = splitTopLevelComma('id, `a, b`, `a b`, cityHash64(a, b)')
    expect(pulled).toEqual(['id', '`a, b`', '`a b`', 'cityHash64(a, b)'])
    expect(planTypes(['id', 'a, b', 'a b', 'cityHash64(a,b)'], pulled)).toEqual([])
    expect(planTypes(pulled, ['id', 'a, b', 'a b', 'cityHash64(a,b)'])).toEqual([])
    expect(planTypes(pulled, ['id', 'a', 'b', 'a b', 'cityHash64(a,b)'])).toEqual(['drop_table', 'create_table'])
  })
})
