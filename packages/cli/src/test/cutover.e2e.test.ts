import { describe, test } from 'bun:test'

import { liveCutoverTarget, runKeepScenario } from './cutover-scenario.js'

// Zero-downtime cutover of a sort-key change (#202) under concurrent writers,
// against the local stack or ObsessionDB (CHKIT_E2E_TARGET=obsessiondb).
// The backfill and retry scenarios live in their own files so
// `bun test --parallel` runs them beside this one. The 2-shard cluster runs
// the same scenarios in test/cluster-2shard-cutover.e2e.test.ts.
describe('generate --cutover e2e (#202)', () => {
  test('keeps every row and the dependent views while writers insert during the cutover', async () => {
    await runKeepScenario(liveCutoverTarget(), 'cutover_keep')
  }, 900_000)
})
