import { describe, expect, test } from 'bun:test'

import { type ColumnDefinition, planDiff, table, toCreateSQL } from './index.js'

describe('nullable column types', () => {
  test('renders and compares inline Nullable and nullable properties equivalently', () => {
    for (const type of ['String', "DateTime64(3, 'UTC')", 'Decimal(12, 3)', 'LowCardinality(String)']) {
      const inline = definition({ name: 'value', type: `Nullable(${type})` })
      const property = definition({ name: 'value', type, nullable: true })
      expect(toCreateSQL(inline)).toBe(toCreateSQL(property))
      expect(planDiff([inline], [property]).operations).toEqual([])
      expect(planDiff([property], [inline]).operations).toEqual([])
    }
  })

  test('still modifies real type, nullability and nested wrapper changes', () => {
    const differences: Array<[ColumnDefinition, ColumnDefinition]> = [
      [{ name: 'value', type: 'Nullable(String)' }, { name: 'value', type: 'String' }],
      [{ name: 'value', type: 'String' }, { name: 'value', type: 'String', nullable: true }],
      [{ name: 'value', type: 'Nullable(String)' }, { name: 'value', type: 'UInt64', nullable: true }],
      [{ name: 'value', type: 'Nullable(String)', nullable: true }, { name: 'value', type: 'String', nullable: true }],
      [{ name: 'value', type: 'LowCardinality(Nullable(String))' }, { name: 'value', type: 'LowCardinality(String)', nullable: true }],
      [{ name: 'value', type: 'Array(Nullable(String))' }, { name: 'value', type: 'Array(String)' }],
    ]
    for (const [oldColumn, newColumn] of differences) {
      const oldDefinition = definition(oldColumn)
      const newDefinition = definition(newColumn)
      expect(planDiff([oldDefinition], [newDefinition]).operations.map((operation) => operation.type))
        .toEqual(['alter_table_modify_column'])
      expect(planDiff([newDefinition], [oldDefinition]).operations.map((operation) => operation.type))
        .toEqual(['alter_table_modify_column'])
    }
  })

  test('keeps defaults, comments and codecs in nullable column comparisons', () => {
    const inline = definition({ name: 'value', type: 'Nullable(String)', default: 'a', comment: 'original' })
    const property = { name: 'value', type: 'String', nullable: true, default: 'a', comment: 'original' }
    expect(planDiff([inline], [definition(property)]).operations).toEqual([])
    for (const column of [
      { ...property, default: 'b' },
      { ...property, comment: 'changed' },
      { ...property, codec: { kind: 'ZSTD', level: 3 } },
    ] satisfies ColumnDefinition[]) {
      expect(planDiff([inline], [definition(column)]).operations.map((operation) => operation.type))
        .toEqual(['alter_table_modify_column'])
    }
  })

  test('removes a codec when only its nullable spelling also changes', () => {
    const oldDefinition = definition({
      name: 'value', type: 'Nullable(String)', codec: { kind: 'ZSTD', level: 3 },
    })
    const newDefinition = definition({ name: 'value', type: 'String', nullable: true })
    expect(planDiff([oldDefinition], [newDefinition]).operations.map((operation) => operation.sql))
      .toEqual(['ALTER TABLE app.events MODIFY COLUMN `value` REMOVE CODEC;'])
  })
})

function definition(column: ColumnDefinition) {
  return table({
    database: 'app',
    name: 'events',
    engine: 'MergeTree()',
    columns: [{ name: 'id', type: 'UInt64' }, column],
    orderBy: ['id'],
  })
}
