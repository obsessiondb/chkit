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
    expect(keyClauseFingerprint("`a''b`")).not.toBe(keyClauseFingerprint("`a'b`"))
  })

  test('a quoted name decodes its escapes as ClickHouse does', () => {
    // ClickHouse reads `a\x41` as aA and `a\nb` with a newline, but keeps the
    // backslash of an unknown escape: `a\q` names the column a\q, not aq.
    expect(keyClauseFingerprint('`a\\x41`')).toBe(keyClauseFingerprint('aA'))
    expect(keyClauseFingerprint('`a\\nb`')).toBe(keyClauseFingerprint('`a\nb`'))
    expect(keyClauseFingerprint('`a\\q`')).toBe(keyClauseFingerprint('`a\\\\q`'))
    expect(keyClauseFingerprint('`a\\q`')).not.toBe(keyClauseFingerprint('aq'))
  })

  test('a bare NULL is the literal, not a column named null', () => {
    expect(keyClauseFingerprint('if(`null` = 1, a, b)')).not.toBe(keyClauseFingerprint('if(NULL = 1, a, b)'))
    expect(keyClauseFingerprint('if(null = 1, a, b)')).not.toBe(keyClauseFingerprint('if("null" = 1, a, b)'))
  })

  test('null after a dot is a name, the null map of a Nullable column', () => {
    // ClickHouse writes c.null back as c.`null`.
    expect(keyClauseFingerprint('c.null')).toBe(keyClauseFingerprint('c.`null`'))
    expect(keyClauseFingerprint('`c` . null')).toBe(keyClauseFingerprint('c.`null`'))
  })

  test('the same strings as chkit-py', () => {
    // tests/test_key_clause_fingerprint.py expects these exact strings.
    expect(keyClauseFingerprint('`id`, `a, b`, `x\\`y`, "q\\\\z", toStartOfHour( ts ) -- c')).toBe(
      "`'id' , `'a, b' , `'x`y' , `'q\\\\z' , `'toStartOfHour' ( `'ts' )"
    )
    expect(keyClauseFingerprint("if(NULL, `a\\x41`, '\\x41'), `\\xC3\\xA9`, `a\\xZZ`")).toBe(
      "`'if' ( NULL , `'aA' , '\\x41' ) , `'\\xc3\\xa9' , `a\\xZZ`"
    )
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

  test('a name spelled with or without escapes compares as the column ClickHouse reads', () => {
    const escaped = (orderBy: string[]) =>
      table({
        database: 'app',
        name: 'events',
        engine: 'MergeTree()',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'a\\q', type: 'String' },
          { name: 'aq', type: 'String' },
          { name: 'eA', type: 'String' },
        ],
        orderBy,
      })
    const types = (from: string[], to: string[]) => planDiff([escaped(from)], [escaped(to)]).operations.map((op) => op.type)
    expect(types(['id', 'a\\q'], ['id', '`a\\q`'])).toEqual([])
    expect(types(['id', '`a\\q`'], ['id', 'aq'])).toEqual(['drop_table', 'create_table'])
    expect(types(['id', 'eA'], ['id', '`e\\x41`'])).toEqual([])
  })

  test('a column named true compares equal however it is quoted, as ClickHouse writes it bare', () => {
    const withTrue = (orderBy: string[]) =>
      table({
        database: 'app',
        name: 'events',
        engine: 'MergeTree()',
        columns: [{ name: 'id', type: 'UInt64' }, { name: 'true', type: 'UInt8' }],
        orderBy,
      })
    // system.tables.sorting_key for ORDER BY (`id`, `true`) is `id, true`.
    expect(planDiff([withTrue(['id', 'true'])], [withTrue(splitTopLevelComma('id, true'))]).operations).toEqual([])
    expect(planDiff([withTrue(['id', '`true`'])], [withTrue(['id', 'true'])]).operations).toEqual([])
  })

  test('a qualified null spelled bare or quoted plans nothing', () => {
    expect(planTypes(['id', 'if(a.null, 0, 1)'], ['id', 'if(a.`null`, 0, 1)'])).toEqual([])
    expect(planTypes(['id', 'if(isNull(a), 0, 1)'], ['id', 'if(isNull(`null`), 0, 1)'])).toEqual(['drop_table', 'create_table'])
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
