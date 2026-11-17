import { describe, expect, test } from 'bun:test'

import { canonicalizeDefinitions, compareCodePoints, table } from './index'

/**
 * #489: the TypeScript side sorted names with `localeCompare` while chkit-py
 * uses Python's default code-point order. The same schema then produced
 * migrations, rename suggestions, canonical snapshots and drift output in a
 * different order depending on which implementation ran.
 */
describe('compareCodePoints (#489)', () => {
  test('orders `_` after digits, like Python', () => {
    expect(['a1', 'a_b'].sort(compareCodePoints)).toEqual(['a1', 'a_b'])
  })

  test('orders upper case before lower case, like Python', () => {
    expect(['orders', 'Users', 't', 'T'].sort(compareCodePoints)).toEqual([
      'T',
      'Users',
      'orders',
      't',
    ])
  })

  test('matches Python order for names that differ only in case', () => {
    expect(canonicalizeDefinitions([
      table({ database: 'app', name: 'orders', columns: [{ name: 'id', type: 'UInt64' }], engine: 'MergeTree()', orderBy: ['id'] }),
      table({ database: 'app', name: 'Users', columns: [{ name: 'id', type: 'UInt64' }], engine: 'MergeTree()', orderBy: ['id'] }),
      table({ database: 'app', name: 'a_b', columns: [{ name: 'id', type: 'UInt64' }], engine: 'MergeTree()', orderBy: ['id'] }),
      table({ database: 'app', name: 'a1', columns: [{ name: 'id', type: 'UInt64' }], engine: 'MergeTree()', orderBy: ['id'] }),
    ]).map((definition) => definition.name)).toEqual(['Users', 'a1', 'a_b', 'orders'])
  })
})
