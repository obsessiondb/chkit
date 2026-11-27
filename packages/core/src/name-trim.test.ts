import { describe, expect, test } from 'bun:test'

import { canonicalizeDefinitions } from './canonical.js'
import { dictionary, materializedView, table, view } from './model.js'
import { validateDefinitions } from './validate.js'

// Names are trimmed with String.prototype.trim, which strips ﻿ but keeps
// \x1c-\x1f and \x85. chkit-py's test_name_trim.py asserts the same (#580).
const wrap = (name: string) => `﻿${name}\x85`

describe('names trim JavaScript whitespace', () => {
  test('canonical names of every kind', () => {
    const [t, v, mv, d] = canonicalizeDefinitions([
      table({
        database: wrap('app'),
        name: wrap('t'),
        renamedFrom: { database: wrap('app'), name: wrap('old_t') },
        engine: 'MergeTree()',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: wrap('c'), type: 'UInt64', renamedFrom: '\x1cold_c﻿' },
        ],
        orderBy: ['id'],
      }),
      view({ database: wrap('app'), name: wrap('v'), as: 'SELECT 1' }),
      materializedView({
        database: wrap('app'),
        name: wrap('mv'),
        to: { database: wrap('app'), name: wrap('t') },
        as: 'SELECT 1',
        refresh: { every: '1 hour', dependsOn: [{ database: wrap('app'), name: wrap('src') }] },
      }),
      dictionary({
        database: wrap('app'),
        name: wrap('d'),
        renamedFrom: { name: wrap('old_d') },
        attributes: [
          { name: wrap('k'), type: 'UInt64' },
          { name: 'lo', type: 'Date' },
          { name: 'hi', type: 'Date' },
        ],
        primaryKey: ['k\x85'],
        source: 'NULL()',
        layout: 'RANGE_HASHED()',
        lifetime: '0',
        range: { min: wrap('lo'), max: wrap('hi') },
      }),
    ])
    expect(t).toMatchObject({
      database: 'app\x85',
      name: 't\x85',
      renamedFrom: { database: 'app\x85', name: 'old_t\x85' },
      columns: [{ name: 'id' }, { name: 'c\x85', renamedFrom: '\x1cold_c' }],
    })
    expect(v).toMatchObject({ database: 'app\x85', name: 'v\x85' })
    expect(mv).toMatchObject({
      database: 'app\x85',
      name: 'mv\x85',
      to: { database: 'app\x85', name: 't\x85' },
      refresh: { dependsOn: [{ database: 'app\x85', name: 'src\x85' }] },
    })
    expect(d).toMatchObject({
      database: 'app\x85',
      name: 'd\x85',
      renamedFrom: { name: 'old_d\x85' },
      attributes: [{ name: 'k\x85' }, { name: 'lo' }, { name: 'hi' }],
      primaryKey: ['k\x85'],
      range: { min: 'lo\x85', max: 'hi\x85' },
    })
  })

  test('a column named in the engine arguments keeps a trailing \\x85', () => {
    const def = table({
      database: 'app',
      name: 't',
      engine: 'SummingMergeTree(c\x85)',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'c\x85', type: 'UInt64', defaultKind: 'EPHEMERAL' },
      ],
      orderBy: ['id'],
    })
    expect(validateDefinitions([def]).map((issue) => issue.code)).toEqual(['column_kind_not_stored'])
  })
})
