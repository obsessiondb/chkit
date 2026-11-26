import { describe, test } from 'bun:test'

import { migrateColumnChange } from './migrate-column-change.js'

// Names in an expression that are not columns of the table (a function, a
// lambda parameter, a keyword) must not change the order of the column statements.
describe('@chkit/cli migrate orders the column statements of a table around names that are not columns (#768, #799, #805)', () => {
  test('a function call named like a new column does not hold back the rename it reads', async () => {
    await migrateColumnChange({
      label: 'fnrename',
      before: "{ name: 'a', type: 'UInt64', default: { expression: \"length('abc')\" } }",
      after:
        "{ name: 'b', type: 'UInt64', default: { expression: \"length('abc')\" } }, { name: 'length', type: 'UInt64', default: { expression: 'b + 1' } }",
      rename: 'a=b',
      order: ['RENAME COLUMN IF EXISTS `a` TO `b`;', 'ADD COLUMN IF NOT EXISTS `length` UInt64 DEFAULT b + 1;'],
      columns: ['b', 'id', 'length'],
    })
  }, 120_000)

  // Reading the lambda parameter `c` as the new column `c` ran MODIFY `a`
  // last, so MODIFY `b` DEFAULT a met the old `a DEFAULT b`: Cyclic alias
  // detected in column DEFAULT expressions (#768).
  test('a lambda parameter named like a new column does not hold back the MODIFY that declares it (#768)', async () => {
    await migrateColumnChange({
      label: 'lambdaparam',
      before:
        "{ name: 'a', type: 'UInt64', default: { expression: 'b' } }, { name: 'b', type: 'UInt64', default: { expression: 'id' } }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'arraySum(arrayMap(c -> c, [1]))' } }, { name: 'b', type: 'UInt64', default: { expression: 'a' } }, { name: 'c', type: 'UInt64', default: { expression: 'id' } }",
      order: ['MODIFY COLUMN `a` UInt64 DEFAULT arraySum(arrayMap(c -> c, [1]));', 'MODIFY COLUMN `b` UInt64 DEFAULT a;'],
      columns: ['a', 'b', 'c', 'id'],
    })
  }, 120_000)

  // ALTER's check for cyclic defaults counts a lambda parameter named like a
  // column as a read of it, so MODIFY `a` first met the other side of the
  // cycle: Cyclic alias detected in column DEFAULT expressions (#799).
  test('an old lambda parameter named like a column holds back the MODIFY that reads it back (#799)', async () => {
    await migrateColumnChange({
      label: 'lambdaold',
      before:
        "{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: 'arraySum(arrayMap(a -> 1, [1]))' } }",
      after: "{ name: 'a', type: 'UInt64', default: { expression: 'b' } }, { name: 'b', type: 'UInt64' }",
      order: ['MODIFY COLUMN `b` REMOVE DEFAULT;', 'MODIFY COLUMN `a` UInt64 DEFAULT b;'],
      columns: ['a', 'b', 'id'],
    })
  }, 120_000)

  test('a new lambda parameter named like a column waits for the release of its old read back (#799)', async () => {
    await migrateColumnChange({
      label: 'lambdanew',
      before: "{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: 'a' } }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'arraySum(arrayMap(b -> 1, [1]))' } }, { name: 'b', type: 'UInt64' }",
      order: ['MODIFY COLUMN `b` REMOVE DEFAULT;', 'MODIFY COLUMN `a` UInt64 DEFAULT arraySum(arrayMap(b -> 1, [1]));'],
      columns: ['a', 'b', 'id'],
    })
  }, 120_000)

  // Reading the CASE's `end` as the column `end` made the two DROPs a cycle,
  // so `a` was dropped first: Cannot drop column `a`, because column `end`
  // depends on it (#805).
  test('a CASE keyword named like a column does not hold back the DROP of the column it names', async () => {
    await migrateColumnChange({
      label: 'casekeyword',
      before:
        "{ name: 'a', type: 'UInt64', default: { expression: 'case when id = 1 then 2 else 3 end' } }, { name: 'end', type: 'UInt64', default: { expression: 'a + 1' } }",
      after: "{ name: 'x', type: 'UInt64' }",
      order: ['DROP COLUMN IF EXISTS `end`;', 'DROP COLUMN IF EXISTS `a`;'],
      columns: ['id', 'x'],
    })
  }, 120_000)
})
