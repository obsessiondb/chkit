import { describe, test } from 'bun:test'

import { GRANULARITY_CHANGE, liveCutoverTarget, runRetryScenario } from './cutover-scenario.js'

describe('generate --cutover e2e (#202)', () => {
  test('cuts over an index_granularity change, resuming after a failure at every step (#511)', async () => {
    await runRetryScenario(liveCutoverTarget(), 'cutover_granularity', GRANULARITY_CHANGE)
  }, 1_800_000)
})
