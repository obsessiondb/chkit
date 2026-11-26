import { describe, test } from 'bun:test'

import {
  liveCutoverTarget,
  runCreatedOutsideChkitScenario,
  runKeepScenario,
  runRefusedAtStartScenario,
  runStoredSpellingScenario,
  runUndeclaredPrimaryKeyScenario,
} from './cutover-scenario.js'

const MISTYPED = 'stores a column with another type than the schema declares'
const BASE = [
  { name: 'id', type: 'UInt64' },
  { name: 'user_id', type: 'UInt64' },
  { name: 'payload', type: 'String' },
]

// Zero-downtime cutover of a sort-key change (#202) under concurrent writers,
// against the local stack or ObsessionDB (CHKIT_E2E_TARGET=obsessiondb).
// The backfill and retry scenarios live in their own files so
// `bun test --parallel` runs them beside this one. The 2-shard cluster runs
// the same scenarios in test/cluster-2shard-cutover.e2e.test.ts.
describe('generate --cutover e2e (#202)', () => {
  test('keeps every row and the dependent views while writers insert during the cutover', async () => {
    await runKeepScenario(liveCutoverTarget(), 'cutover_keep')
  }, 900_000)

  test('keeps flattened Nested rows while writers insert during the cutover', async () => {
    await runKeepScenario(liveCutoverTarget(), 'cutover_keep_nested', true)
  }, 900_000)

  test('cuts over a table created with only ORDER BY, without PRIMARY KEY (#524)', async () => {
    await runUndeclaredPrimaryKeyScenario(liveCutoverTarget(), 'cutover_pk')
  }, 300_000)

  // cityHash64 hashes both pairs alike, so the verify step after the copy would miss them.
  test('stops before it creates anything when the table stores UInt32 where the schema says UInt64', async () => {
    const target = liveCutoverTarget()
    await runRefusedAtStartScenario(target, 'cutover_uint', { columns: 'id UInt32, user_id UInt64, payload String', engine: () => target.engine }, MISTYPED)
  }, 300_000)

  test('stops before it creates anything when the table stores LowCardinality(String) where the schema says String', async () => {
    const target = liveCutoverTarget()
    await runRefusedAtStartScenario(target, 'cutover_lowcard', { columns: 'id UInt64, user_id UInt64, payload LowCardinality(String)', engine: () => target.engine }, MISTYPED)
  }, 300_000)

  // ClickHouse stores Decimal64(2) as Decimal(18, 2): the same type, in another spelling.
  test('cuts over a table whose types ClickHouse stores in another spelling', async () => {
    await runStoredSpellingScenario(liveCutoverTarget(), 'cutover_spelling', [
      ...BASE,
      { name: 'price', type: 'Decimal64(2)' },
      { name: 'maybe_price', type: 'Decimal64(2)', nullable: true },
      { name: 'prices', type: 'Array(Decimal64(2))' },
      { name: 'pair', type: 'Tuple(a Decimal128(4), `b c` INT)' },
    ])
  }, 300_000)

  // defaultValueOfTypeName fails for this type on ClickHouse 26.3 (ClickHouse#102403), and so does
  // the default of an omitted column: the DEFAULT expression lets the scenario insert without it.
  test('cuts over a table with an AggregateFunction column over LowCardinality', async () => {
    await runStoredSpellingScenario(liveCutoverTarget(), 'cutover_aggregate', [
      ...BASE,
      {
        name: 'last',
        type: 'AggregateFunction(argMax, LowCardinality(String), DateTime)',
        default: { expression: "arrayReduce('argMaxState', [toLowCardinality('')], [toDateTime(0)])" },
      },
    ])
  }, 300_000)

  // AS copies the table's engine: a SummingMergeTree snapshot would merge rows away before the copy.
  test('stops before it creates anything when the table uses SummingMergeTree where the schema says MergeTree', async () => {
    await runRefusedAtStartScenario(
      liveCutoverTarget(),
      'cutover_summing',
      { columns: 'id UInt64, user_id UInt64, payload String', engine: () => 'SummingMergeTree' },
      'does not use the engine the schema declares',
    )
  }, 300_000)

  test('stops before it creates anything when the table stores a Nested column without flattening', async () => {
    const target = liveCutoverTarget()
    await runRefusedAtStartScenario(
      target,
      'cutover_nested_whole',
      {
        columns: 'id UInt64, user_id UInt64, payload String, n Nested(x UInt64, `y z` Decimal64(2))',
        engine: () => target.engine,
        settings: { flatten_nested: 0 },
      },
      'stores a Nested column as one column (created with flatten_nested = 0)',
      [...BASE, { name: 'n', type: 'Nested(x UInt64, `y z` Decimal64(2))' }],
    )
  }, 300_000)

  // ClickHouse writes the column name TTL unquoted in the key: it is not a TTL.
  test('cuts over a table with a column named TTL in its key', async () => {
    await runCreatedOutsideChkitScenario(
      liveCutoverTarget(),
      'cutover_ttl_column',
      { columns: 'id UInt64, user_id UInt64, payload String, TTL DateTime', orderBy: '(id, TTL)' },
      [...BASE, { name: 'TTL', type: 'DateTime' }],
    )
  }, 300_000)

  test('stops before it creates anything when the table lacks a Nested column of the schema', async () => {
    const target = liveCutoverTarget()
    await runRefusedAtStartScenario(
      target,
      'cutover_nested_missing',
      { columns: 'id UInt64, user_id UInt64, payload String', engine: () => target.engine },
      'lacks a column that the schema declares',
      [...BASE, { name: 'n', type: 'Nested(x UInt64)' }],
    )
  }, 300_000)

  test('stops before it creates anything when a Nested field of the table has another type', async () => {
    const target = liveCutoverTarget()
    await runRefusedAtStartScenario(
      target,
      'cutover_nested_type',
      { columns: 'id UInt64, user_id UInt64, payload String, n Nested(x UInt32)', engine: () => target.engine },
      MISTYPED,
      [...BASE, { name: 'n', type: 'Nested(x UInt64)' }],
    )
  }, 300_000)

  // The mirror, the copy and the verify skip an ALIAS column, so the stored values would be lost.
  test('stops before it creates anything when the table stores a column the schema declares ALIAS', async () => {
    const target = liveCutoverTarget()
    await runRefusedAtStartScenario(
      target,
      'cutover_alias',
      { columns: 'id UInt64, user_id UInt64, payload String, label String', engine: () => target.engine },
      'stores a column that the schema declares ALIAS or EPHEMERAL',
      [...BASE, { name: 'label', type: 'String', defaultKind: 'ALIAS', default: { expression: 'payload' } }],
    )
  }, 300_000)

  // AS keeps the table's TTLs: a TTL merge on the snapshot could change rows before the copy.
  for (const [label, created] of [
    ['cutover_table_ttl', { columns: 'id UInt64, user_id UInt64, payload String', clauses: 'TTL toDateTime(id) + toIntervalYear(100)' }],
    ['cutover_column_ttl', { columns: 'id UInt64, user_id UInt64, payload String TTL toDateTime(id) + toIntervalYear(100)' }],
  ] as const) {
    test(`stops before it creates anything when the table has a TTL (${label})`, async () => {
      const target = liveCutoverTarget()
      await runRefusedAtStartScenario(target, label, { ...created, engine: () => target.engine }, 'has a TTL')
    }, 300_000)
  }
})
