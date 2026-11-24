import { describe, test } from 'bun:test'

import { GRANULARITY_CHANGE, liveCutoverTarget, runRetryScenario } from './cutover-scenario.js'

describe('generate --cutover e2e (#202)', () => {
  test('cuts over an index_granularity change, and its layout guards tell the tables apart by it (#511)', async () => {
    await runRetryScenario(liveCutoverTarget(), 'cutover_granularity', GRANULARITY_CHANGE, 'layout guards')
  }, 900_000)
})
