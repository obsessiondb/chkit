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

  test('a literal default compares by value with the escapes and float form ClickHouse stores', () => {
    const pairs: Array<[ColumnDefaultValue, string]> = [
      ["it's", "'it\\'s'"],
      ['x\ny', "'x\\ny'"],
      ['x\ty', "'x\\ty'"],
      ['back\\slash', "'back\\\\slash'"],
      [2.0, '2.'],
      [2.5, '2.5'],
    ]
    for (const [declared, stored] of pairs) {
      expect(planDiff([events({ default: declared })], [events({ default: { expression: stored } })]).operations).toEqual([])
      expect(planDiff([events({ default: { expression: stored } })], [events({ default: declared })]).operations).toEqual([])
    }
    expect(planDiff([events({ default: "it's" })], [events({ default: { expression: "'its'" } })]).operations).toHaveLength(1)
    expect(planDiff([events({ default: 2 })], [events({ default: { expression: "'2'" } })]).operations).toHaveLength(1)
  })

  test('a default that renders another clause still plans a MODIFY COLUMN', () => {
    const plan = planDiff([events({ default: 7 })], [events({ default: { expression: '8' } })])
    expect(plan.operations.map((op) => op.sql)).toEqual(['ALTER TABLE app.events MODIFY COLUMN `n` UInt8 DEFAULT 8;'])
  })

  test('a setting compares by its value, in the forms ClickHouse stores', () => {
    const declared = events({
      settings: { merge_selecting_sleep_slowdown_factor: 2.0, min_bytes_for_wide_part: 1e6, ttl_only_drop_parts: true },
    })
    const pulled = events({
      settings: {
        index_granularity: '8192',
        merge_selecting_sleep_slowdown_factor: '2.',
        min_bytes_for_wide_part: '1000000.',
        ttl_only_drop_parts: 'true',
      },
    })
    expect(planDiff([declared], [pulled]).operations).toEqual([])
    expect(planDiff([pulled], [declared]).operations).toEqual([])
  })

  test('a MergeTree table without index_granularity has the 8192 ClickHouse stores', () => {
    expect(planDiff([events({})], [events({ settings: { index_granularity: '8192' } })]).operations).toEqual([])
    expect(planDiff([events({ settings: { index_granularity: 8192 } })], [events({})]).operations).toEqual([])
    const created = planDiff([], [events({})]).operations.find((op) => op.type === 'create_table')?.sql
    expect(created).toEndWith('SETTINGS index_granularity = 8192;')
  })

  test('an editable setting still plans MODIFY SETTING', () => {
    const plan = planDiff([events({ settings: { ttl_only_drop_parts: 0 } })], [events({ settings: { ttl_only_drop_parts: 1 } })])
    expect(plan.operations.map((op) => op.sql)).toEqual(['ALTER TABLE app.events MODIFY SETTING ttl_only_drop_parts = 1;'])
  })

  test('a read-only setting change recreates the table, as ClickHouse cannot alter it', () => {
    const plan = planDiff([events({ settings: { index_granularity: '4096' } })], [events({})])
    expect(plan.operations.map((op) => [op.type, op.risk])).toEqual([
      ['drop_table', 'danger'],
      ['create_table', 'safe'],
    ])
    expect(plan.operations[1]?.sql).toContain('SETTINGS index_granularity = 8192;')
    const minmax = planDiff([events({})], [events({ settings: { add_minmax_index_for_numeric_columns: 1 } })])
    expect(minmax.operations.map((op) => op.type)).toEqual(['drop_table', 'create_table'])
  })

  test('hidden minmax indexes the server creates plan nothing', () => {
    const autoIndex = { name: 'auto_minmax_index_id', expression: 'id', type: 'minmax' as const, granularity: 1 }
    const withAuto = { ...events({ settings: { add_minmax_index_for_numeric_columns: '1' } }), indexes: [autoIndex] }
    const withoutAuto = events({ settings: { add_minmax_index_for_numeric_columns: 1 } })
    expect(planDiff([withAuto], [withoutAuto]).operations).toEqual([])
    expect(planDiff([withoutAuto], [withAuto]).operations).toEqual([])
    // With the settings off, the server allows a user index of that name, so it is compared.
    const userIndex = planDiff([events({})], [{ ...events({}), indexes: [autoIndex] }])
    expect(userIndex.operations.map((op) => op.type)).toEqual(['alter_table_add_index'])
  })

  test('engines outside the MergeTree family get no index_granularity', () => {
    const memory = table({ database: 'app', name: 'buffer', engine: 'Memory()', columns: [{ name: 'id', type: 'UInt64' }] })
    expect(planDiff([], [memory]).operations.find((op) => op.type === 'create_table')?.sql).not.toContain('index_granularity')
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

  test('a changed default plans a MODIFY COLUMN even where a float would round both alike', () => {
    const pairs: Array<[string, string]> = [
      ['18446744073709551615', '18446744073709551614'],
      ['9007199254740992', '9007199254740993'],
    ]
    for (const [before, after] of pairs) {
      const plan = planDiff([events({ default: { expression: before } })], [events({ default: { expression: after } })])
      expect(plan.operations.map((op) => op.type)).toEqual(['alter_table_modify_column'])
    }
    expect(planDiff([events({ default: 1e21 })], [events({ default: { expression: '1e21' } })]).operations).toEqual([])
    // The forms ClickHouse 26.3 stores: the JS number 2^64 renders 18446744073709552000, which
    // ClickHouse reads as a Float64 and stores as `18446744073709552000.`; `9007199254740993.` is
    // stored as the Float64 it reads, `9007199254740992.`.
    expect(planDiff([events({ default: 2 ** 64 })], [events({ default: { expression: '18446744073709552000.' } })]).operations).toEqual([])
    expect(planDiff([events({ default: { expression: '9007199254740993.' } })], [events({ default: { expression: '9007199254740992.' } })]).operations).toEqual([])
    // An integer and the Float64 spelling of it above 2^53 are different defaults (Codex review).
    expect(planDiff([events({ default: { expression: '9007199254740993.' } })], [events({ default: { expression: '9007199254740993' } })]).operations.map((op) => op.type)).toEqual(['alter_table_modify_column'])
  })

  test('a string default with an escape ClickHouse decodes otherwise is a change', () => {
    // ClickHouse reads '\e' as the ESC byte and drops '\N'; '\q' keeps its backslash.
    const changed: Array<[string, string]> = [
      ["'\\e'", 'e'],
      ["'\\N'", 'N'],
      ["'\\q'", 'q'],
    ]
    for (const [stored, declared] of changed) {
      const plan = planDiff([events({ default: { expression: stored } })], [events({ default: declared })])
      expect(plan.operations.map((op) => op.type)).toEqual(['alter_table_modify_column'])
    }
    const same: Array<[string, string]> = [
      ["'\\e'", '\x1b'],
      ["'\\x41'", 'A'],
      ["'\\\"'", '"'],
      ["'a\\=b'", 'a=b'],
      ["'it''s'", "it's"],
    ]
    for (const [stored, declared] of same) {
      expect(planDiff([events({ default: { expression: stored } })], [events({ default: declared })]).operations).toEqual([])
    }
  })

  test('a read-only setting written true or 1 plans nothing', () => {
    const plan = planDiff(
      [events({ settings: { add_minmax_index_for_numeric_columns: true } })],
      [events({ settings: { add_minmax_index_for_numeric_columns: 1 } })]
    )
    expect(plan.operations).toEqual([])
    const off = planDiff([events({ settings: { add_minmax_index_for_numeric_columns: 'false' } })], [events({ settings: { add_minmax_index_for_numeric_columns: 0 } })])
    expect(off.operations).toEqual([])
  })

  test('columns, indexes, projections and constraints compare whatever order their keys are written in', () => {
    const declared = table({
      database: 'app', name: 'keyed', engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'],
      columns: [{ name: 'id', type: 'UInt64' }, { name: 'n', type: 'UInt8', default: 1, comment: 'count' }],
      indexes: [{ name: 'idx_n', type: 'minmax', expression: 'n', granularity: 1 }],
      projections: [{ name: 'p', query: 'SELECT n ORDER BY n' }],
      constraints: [{ name: 'c', check: 'n < 10' }],
    })
    const pulled = table({
      database: 'app', name: 'keyed', engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'],
      columns: [{ name: 'id', type: 'UInt64' }, { comment: 'count', default: 1, type: 'UInt8', name: 'n' }],
      indexes: [{ name: 'idx_n', expression: 'n', granularity: 1, type: 'minmax' }],
      projections: [{ query: 'SELECT n ORDER BY n', name: 'p' }],
      constraints: [{ check: 'n < 10', name: 'c' }],
    })
    expect(planDiff([declared], [pulled]).operations).toEqual([])
    expect(planDiff([pulled], [declared]).operations).toEqual([])
  })

  test('a column type compares in the spacing ClickHouse stores, quotes as written', () => {
    const typed = (types: string[]) => table({
      database: 'app', name: 'typed', engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'],
      columns: [{ name: 'id', type: 'UInt64' }, ...types.map((type, i) => ({ name: `c${i}`, type }))],
    })
    const declared = typed([
      'Decimal(10,2)', "DateTime64(3,'UTC')", 'Map(String,UInt64)', 'Nullable(Decimal(10,2))',
      'Tuple(a UInt8,b String)', "Enum8('a'=1,'b'=2)",
    ])
    const stored = typed([
      'Decimal(10, 2)', "DateTime64(3, 'UTC')", 'Map(String, UInt64)', 'Nullable(Decimal(10, 2))',
      'Tuple(a UInt8, b String)', "Enum8('a' = 1, 'b' = 2)",
    ])
    expect(planDiff([declared], [stored]).operations).toEqual([])
    expect(planDiff([stored], [declared]).operations).toEqual([])
    const label = planDiff([typed(["Enum8('a b'=1)"])], [typed(["Enum8('a  b' = 1)"])])
    expect(label.operations.map((op) => op.type)).toEqual(['alter_table_modify_column'])
    // What chkit writes keeps the declared spelling.
    expect(planDiff([], [declared]).operations.find((op) => op.type === 'create_table')?.sql).toContain('`c0` Decimal(10,2)')
  })

  test('a table without index_granularity gets the configured server default', () => {
    const options = { indexGranularity: 4096 }
    expect(planDiff([events({})], [events({ settings: { index_granularity: '4096' } })], options).operations).toEqual([])
    expect(planDiff([events({ settings: { index_granularity: 4096 } })], [events({})], options).operations).toEqual([])
    expect(planDiff([events({})], [events({ settings: { index_granularity: '4096' } })]).operations.map((op) => op.type)).toEqual([
      'drop_table',
      'create_table',
    ])
    const created = planDiff([], [events({})], options).operations.find((op) => op.type === 'create_table')?.sql
    expect(created).toEndWith('SETTINGS index_granularity = 4096;')
  })
})
