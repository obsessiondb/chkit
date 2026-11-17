import { describe, test } from 'bun:test'

import {
  liveCutoverTarget,
  runBackfillScenario,
  runKeepScenario,
  runRefusedAtStartScenario,
  runUndeclaredPrimaryKeyScenario,
} from './cutover-scenario.js'

const MISTYPED = 'stores a column with another type than the schema declares'

// Zero-downtime cutover of a sort-key change (#202) under concurrent writers,
// against the local stack or ObsessionDB (CHKIT_E2E_TARGET=obsessiondb).
// The retry scenarios live in their own files so `bun test --parallel` runs
// them beside this one. The 2-shard cluster runs the same scenarios in
// test/cluster-2shard-cutover.e2e.test.ts.
describe('generate --cutover e2e (#202)', () => {
  test('keeps every row and the dependent views while writers insert during the cutover', async () => {
    await runKeepScenario(liveCutoverTarget(), 'cutover_keep')
  }, 900_000)

  test('copies through the backfill plugin, then swaps and drops the old table', async () => {
    await runBackfillScenario(liveCutoverTarget(), 'cutover_backfill')
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
})
