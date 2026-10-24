import { describe, test } from 'bun:test'

import { createLiveExecutor, createStatelessLiveExecutor, getLiveEnv } from './e2e-testkit.js'
import {
  runBackfillScenario,
  runKeepScenario,
  runRetryScenario,
  type CutoverTarget,
} from './cutover-scenario.js'

// Zero-downtime cutover of a sort-key change (#202) under concurrent writers,
// against the local stack or ObsessionDB (CHKIT_E2E_TARGET=obsessiondb).
// The 2-shard cluster runs the same scenarios in
// test/cluster-2shard-cutover.e2e.test.ts.
function liveTarget(): CutoverTarget {
  const env = getLiveEnv()
  const remote = env.clickhouseUrl.startsWith('https://')
  return {
    database: env.clickhouseDatabase,
    connection: {
      url: env.clickhouseUrl,
      username: env.clickhouseUser,
      password: env.clickhousePassword,
      database: env.clickhouseDatabase,
    },
    admin: createLiveExecutor(env),
    writers: [createStatelessLiveExecutor(env), createStatelessLiveExecutor(env)],
    engine: 'MergeTree',
    rowsOf: (table) => `${env.clickhouseDatabase}.${table}`,
    // A SharedMergeTree replica reads the parts every replica committed.
    readSettings: remote ? ' SETTINGS select_sequential_consistency = 1' : '',
  }
}

describe('generate --cutover e2e (#202)', () => {
  test('keeps every row and the dependent views while writers insert during the cutover', async () => {
    await runKeepScenario(liveTarget(), 'cutover_keep')
  }, 900_000)

  test('copies through the backfill plugin, then swaps and drops the old table', async () => {
    await runBackfillScenario(liveTarget(), 'cutover_backfill')
  }, 900_000)

  test('resumes after a failure at every step and never replays the swap', async () => {
    await runRetryScenario(liveTarget(), 'cutover_retry')
  }, 1_800_000)
})
