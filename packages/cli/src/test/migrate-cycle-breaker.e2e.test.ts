import { describe, test } from 'bun:test'

import { migrateColumnChange } from './migrate-column-change.js'

// In key order each change below fails with `Cyclic alias detected`: a MODIFY
// closes a cycle that more than one other MODIFY could break first.
describe('@chkit/cli migrate runs a breaker before the MODIFY that closes a temporary cycle (#775)', () => {
  test('a MODIFY COLUMN runs after the first of two MODIFYs that could break its cycle', async () => {
    await migrateColumnChange({
      label: 'breakany',
      before:
        "{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: 'c' } }, { name: 'c', type: 'UInt64', default: { expression: 'a' } }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'b' } }, { name: 'b', type: 'UInt64', default: { expression: 'id' } }, { name: 'c', type: 'UInt64', default: { expression: 'id' } }",
      order: ['MODIFY COLUMN `b` UInt64 DEFAULT id;', 'MODIFY COLUMN `a` UInt64 DEFAULT b;', 'MODIFY COLUMN `c` UInt64 DEFAULT id;'],
      columns: ['a', 'b', 'c', 'id'],
    })
  }, 120_000)

  test('the second of two MODIFYs that close a cycle runs after the REMOVE DEFAULT that breaks it', async () => {
    await migrateColumnChange({
      label: 'breaktwo',
      before:
        "{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64' }, { name: 'c', type: 'UInt64', default: { expression: 'a' } }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'b' } }, { name: 'b', type: 'UInt64', default: { expression: 'c' } }, { name: 'c', type: 'UInt64' }",
      order: ['MODIFY COLUMN `a` UInt64 DEFAULT b;', 'MODIFY COLUMN `c` REMOVE DEFAULT;', 'MODIFY COLUMN `b` UInt64 DEFAULT c;'],
      columns: ['a', 'b', 'c', 'id'],
    })
  }, 120_000)

  test('a MODIFY COLUMN runs after the REMOVE DEFAULT, not the REMOVE COMMENT, of its breaker', async () => {
    await migrateColumnChange({
      label: 'breakcomment',
      before:
        "{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: 'c' }, comment: 'x' }, { name: 'c', type: 'UInt64', default: { expression: 'a' } }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'b' } }, { name: 'b', type: 'UInt64' }, { name: 'c', type: 'UInt64', default: { expression: 'id' } }",
      order: ['MODIFY COLUMN `b` REMOVE DEFAULT;', 'MODIFY COLUMN `a` UInt64 DEFAULT b;', 'MODIFY COLUMN `b` REMOVE COMMENT;'],
      columns: ['a', 'b', 'c', 'id'],
    })
  }, 120_000)
})
