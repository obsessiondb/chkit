import { describe, test } from 'bun:test'

import { migrateColumnChange } from './migrate-column-change.js'

// Each change below fails on ClickHouse 26.3 in the order of the #759 plan:
// `Cyclic alias detected` when a MODIFY reads back a column whose old DEFAULT
// still reads it, `Missing columns` when a DROP COLUMN runs while the table
// TTL still reads the column.
describe('@chkit/cli migrate orders MODIFY read releases and table TTL changes (#769)', () => {
  test('a MODIFY COLUMN that reads a column back runs after that column stops reading it', async () => {
    await migrateColumnChange({
      label: 'modrelease',
      before: "{ name: 'a', type: 'UInt64' }, { name: 'z', type: 'UInt64', default: { expression: 'a' } }",
      after: "{ name: 'a', type: 'UInt64', default: { expression: 'z' } }, { name: 'z', type: 'UInt64' }",
      order: ['MODIFY COLUMN `z` REMOVE DEFAULT;', 'MODIFY COLUMN `a` UInt64 DEFAULT z;'],
      columns: ['a', 'id', 'z'],
    })
  }, 120_000)

  test('a MODIFY COLUMN that closes a longer cycle runs after the release', async () => {
    await migrateColumnChange({
      label: 'modrelease3',
      before:
        "{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: 'c' } }, { name: 'c', type: 'UInt64', default: { expression: 'a' } }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'b' } }, { name: 'b', type: 'UInt64', default: { expression: 'c' } }, { name: 'c', type: 'UInt64', default: { expression: 'id' } }",
      order: ['MODIFY COLUMN `c` UInt64 DEFAULT id;', 'MODIFY COLUMN `a` UInt64 DEFAULT b;'],
      columns: ['a', 'b', 'c', 'id'],
    })
  }, 120_000)

  test('a MODIFY COLUMN that closes a cycle through an added column runs after the release', async () => {
    await migrateColumnChange({
      label: 'modreleaseadd',
      before: "{ name: 'b', type: 'UInt64' }, { name: 'c', type: 'UInt64', default: { expression: 'b' } }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'c' } }, { name: 'b', type: 'UInt64', default: { expression: 'a' } }, { name: 'c', type: 'UInt64' }",
      order: ['ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT c;', 'MODIFY COLUMN `c` REMOVE DEFAULT;', 'MODIFY COLUMN `b` UInt64 DEFAULT a;'],
      columns: ['a', 'b', 'c', 'id'],
    })
  }, 120_000)

  test('a TTL change runs after the ADD of the column it reads and before the DROP of the column it stops reading', async () => {
    await migrateColumnChange({
      label: 'ttlswap',
      before: "{ name: 'x', type: 'DateTime' }",
      beforeTtl: 'x + INTERVAL 1 DAY',
      after: "{ name: 'y', type: 'DateTime' }",
      afterTtl: 'y + INTERVAL 1 DAY',
      order: ['ADD COLUMN IF NOT EXISTS `y` DateTime;', 'MODIFY TTL y + INTERVAL 1 DAY;', 'DROP COLUMN IF EXISTS `x`;'],
      columns: ['id', 'y'],
    })
  }, 120_000)

  test('a REMOVE TTL runs before the DROP of the column the TTL reads', async () => {
    await migrateColumnChange({
      label: 'ttlremove',
      before: "{ name: 'x', type: 'DateTime' }",
      beforeTtl: 'x + INTERVAL 1 DAY',
      after: "{ name: 'w', type: 'UInt64' }",
      order: ['REMOVE TTL;', 'DROP COLUMN IF EXISTS `x`;'],
      columns: ['id', 'w'],
    })
  }, 120_000)

  test('a TTL change keeps its order when a column rename runs too', async () => {
    await migrateColumnChange({
      label: 'ttlrename',
      before: "{ name: 'a', type: 'UInt64' }, { name: 'x', type: 'DateTime' }",
      beforeTtl: 'x + INTERVAL 1 DAY',
      after: "{ name: 'b', type: 'UInt64' }, { name: 'y', type: 'DateTime' }",
      afterTtl: 'y + INTERVAL 1 DAY',
      rename: 'a=b',
      order: ['ADD COLUMN IF NOT EXISTS `y` DateTime;', 'MODIFY TTL y + INTERVAL 1 DAY;', 'DROP COLUMN IF EXISTS `x`;'],
      columns: ['b', 'id', 'y'],
    })
  }, 120_000)
})
