import { describe, test } from 'bun:test'

import { migrateColumnChange } from './migrate-column-change.js'

// Each change below fails on ClickHouse in the order of an earlier plan: a
// statement reads a column that does not exist yet, or a DROP COLUMN runs
// while another column still reads it.
describe('@chkit/cli migrate orders the column statements of a table (#745, #746, #758)', () => {
  test('a MODIFY COLUMN runs after the ADD COLUMN its new DEFAULT reads (#745)', async () => {
    await migrateColumnChange({
      label: 'modafteradd',
      before: "{ name: 'Total', type: 'UInt64' }",
      after: "{ name: 'Total', type: 'UInt64', default: { expression: 'price + 1' } }, { name: 'price', type: 'UInt64' }",
      order: ['ADD COLUMN IF NOT EXISTS `price` UInt64;', 'MODIFY COLUMN `Total` UInt64 DEFAULT price + 1;'],
      columns: ['Total', 'id', 'price'],
    })
  }, 120_000)

  test('a RENAME COLUMN runs before the ADD COLUMN that reads its new name (#746)', async () => {
    await migrateColumnChange({
      label: 'addafterrename',
      before: "{ name: 'a', type: 'String' }",
      after: "{ name: 'b', type: 'String' }, { name: 'Copy', type: 'String', defaultKind: 'MATERIALIZED', default: { expression: \"concat(b, '!')\" } }",
      rename: 'a=b',
      order: ['RENAME COLUMN IF EXISTS `a` TO `b`;', 'ADD COLUMN IF NOT EXISTS `Copy` String MATERIALIZED'],
      columns: ['Copy', 'b', 'id'],
    })
  }, 120_000)

  test('a RENAME COLUMN runs before the MODIFY COLUMN that reads its new name (#758)', async () => {
    await migrateColumnChange({
      label: 'modafterrename',
      before: "{ name: 'a', type: 'String' }, { name: 'code', type: 'String', default: { expression: 'a' } }",
      after: "{ name: 'b', type: 'String' }, { name: 'code', type: 'String', default: { expression: 'b' } }",
      rename: 'a=b',
      order: ['RENAME COLUMN IF EXISTS `a` TO `b`;', 'MODIFY COLUMN `code` String DEFAULT b;'],
      columns: ['b', 'code', 'id'],
    })
  }, 120_000)

  // Passes on main too; it fails when the DROP keeps its slot while the
  // MODIFY of `b` moves behind the ADD of `z`.
  test('a DROP COLUMN runs after the MODIFY of the column whose old DEFAULT reads it', async () => {
    await migrateColumnChange({
      label: 'dropaftermod',
      before: "{ name: 'b', type: 'UInt64', default: { expression: 'c' } }, { name: 'c', type: 'UInt64' }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'z' } }, { name: 'b', type: 'UInt64', default: { expression: 'z' } }, { name: 'z', type: 'UInt64' }",
      order: ['ADD COLUMN IF NOT EXISTS `z` UInt64;', 'MODIFY COLUMN `b` UInt64 DEFAULT z;', 'DROP COLUMN IF EXISTS `c`;'],
      columns: ['a', 'b', 'id', 'z'],
    })
  }, 120_000)

  test('a DROP COLUMN runs after the dropped column whose expression reads it', async () => {
    await migrateColumnChange({
      label: 'dropafterdrop',
      before: "{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', defaultKind: 'ALIAS', default: { expression: 'a + 1' } }",
      after: "{ name: 'x', type: 'UInt64' }",
      order: ['DROP COLUMN IF EXISTS `b`;', 'DROP COLUMN IF EXISTS `a`;'],
      columns: ['id', 'x'],
    })
  }, 120_000)

  // Passes on main too; it fails when the ADD and the RENAME move while the
  // MODIFY of `d` keeps its slot before the ADD of `c`.
  test('a MODIFY COLUMN stays after the ADD COLUMN it reads when a rename runs too', async () => {
    await migrateColumnChange({
      label: 'modaddrename',
      before: "{ name: 'a', type: 'UInt64' }, { name: 'd', type: 'UInt64' }",
      after:
        "{ name: 'c', type: 'UInt64', default: { expression: \"length('abc')\" } }, { name: 'd', type: 'UInt64', default: { expression: 'c + 1' } }, { name: 'length', type: 'UInt64' }",
      rename: 'a=length',
      order: ['ADD COLUMN IF NOT EXISTS `c` UInt64', 'MODIFY COLUMN `d` UInt64 DEFAULT c + 1;'],
      columns: ['c', 'd', 'id', 'length'],
    })
  }, 120_000)
})

// Each change below fails on ClickHouse 26.3 in key order with code 43:
// ClickHouse checks every expression of the table against a column's new
// type, and a new expression against its current type.
describe('@chkit/cli migrate orders a column type change against the expressions that read it (#814)', () => {
  test('a type change runs after the MODIFY whose new DEFAULT stops reading the column', async () => {
    await migrateColumnChange({
      label: 'typerelease',
      before: "{ name: 'a', type: 'String' }, { name: 'b', type: 'UInt64', default: { expression: 'length(a)' } }",
      after: "{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: '0' } }",
      order: ['MODIFY COLUMN `b` UInt64 DEFAULT 0;', 'MODIFY COLUMN `a` UInt64;'],
      columns: ['a', 'b', 'id'],
    })
  }, 120_000)

  test('an ADD whose DEFAULT reads the column runs after its type change', async () => {
    await migrateColumnChange({
      label: 'typeprovide',
      before: "{ name: 'z', type: 'String' }",
      after: "{ name: 'b', type: 'UInt64', default: { expression: 'z + 1' } }, { name: 'z', type: 'UInt64' }",
      order: ['MODIFY COLUMN `z` UInt64;', 'ADD COLUMN IF NOT EXISTS `b` UInt64 DEFAULT z + 1;'],
      columns: ['b', 'id', 'z'],
    })
  }, 120_000)
})
