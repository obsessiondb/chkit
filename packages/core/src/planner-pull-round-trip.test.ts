import { describe, expect, test } from 'bun:test'

import { dictionary, planDiff, table, type ColumnDefaultValue, type TableDefinition } from './index.js'

// What `chkit pull` reads back from ClickHouse must plan nothing against the
// schema chkit migrated from (#466).

function events(input: { default?: ColumnDefaultValue; settings?: TableDefinition['settings'] }): TableDefinition {
  return table({
    database: 'app',
    name: 'events',
    engine: 'MergeTree()',
    primaryKey: ['id'],
    orderBy: ['id'],
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 'n', type: 'UInt8', ...(input.default === undefined ? {} : { default: input.default }) },
    ],
    ...(input.settings ? { settings: input.settings } : {}),
  })
}

function lookup(lifetime: string) {
  return dictionary({
    database: 'app',
    name: 'lookup',
    attributes: [
      { name: 'k', type: 'UInt64' },
      { name: 'v', type: 'String' },
    ],
    primaryKey: ['k'],
    source: 'NULL()',
    layout: 'HASHED()',
    lifetime,
  })
}

describe('@chkit/core planner: pulled schema round trip', () => {
  test('a default that renders the same clause plans nothing', () => {
    expect(planDiff([events({ default: 7 })], [events({ default: { expression: '7' } })]).operations).toEqual([])
    expect(planDiff([events({ default: 'web' })], [events({ default: { expression: "'web'" } })]).operations).toEqual([])
    expect(planDiff([events({ default: { expression: '7' } })], [events({ default: 7 })]).operations).toEqual([])
  })

  test('a default that renders another clause still plans a MODIFY COLUMN', () => {
    const plan = planDiff([events({ default: 7 })], [events({ default: { expression: '8' } })])
    expect(plan.operations.map((op) => op.sql)).toEqual(['ALTER TABLE app.events MODIFY COLUMN `n` UInt8 DEFAULT 8;'])
  })

  test('a setting compares by the value it renders', () => {
    const declared = events({ settings: { index_granularity: 4096, ttl_only_drop_parts: true } })
    const pulled = events({ settings: { index_granularity: '4096', ttl_only_drop_parts: 'true' } })
    expect(planDiff([declared], [pulled]).operations).toEqual([])
    expect(planDiff([declared], [events({ settings: { index_granularity: '8192', ttl_only_drop_parts: true } })]).operations.map((op) => op.sql)).toEqual([
      'ALTER TABLE app.events MODIFY SETTING index_granularity = 8192;',
    ])
  })

  test('LIFETIME forms ClickHouse stores the same plan nothing', () => {
    expect(planDiff([lookup('300')], [lookup('MIN 0 MAX 300')]).operations).toEqual([])
    expect(planDiff([lookup('MIN 0 MAX 300')], [lookup('300')]).operations).toEqual([])
    expect(planDiff([lookup('MAX 300 MIN 10')], [lookup('MIN 10 MAX 300')]).operations).toEqual([])
    expect(planDiff([lookup('min 5 max 60')], [lookup('MIN 5 MAX 60')]).operations).toEqual([])
  })

  test('a dictionary compares whatever order its keys are written in', () => {
    const declared = lookup('300')
    const { attributes, ...rest } = declared
    expect(planDiff([declared], [{ ...rest, attributes }]).operations).toEqual([])
  })

  test('a LIFETIME that ClickHouse stores differently still replaces the dictionary', () => {
    const plan = planDiff([lookup('300')], [lookup('MIN 10 MAX 300')])
    expect(plan.operations.map((op) => op.type)).toEqual(['create_dictionary'])
    expect(plan.operations[0]?.sql).toContain('LIFETIME(MIN 10 MAX 300)')
  })
})
