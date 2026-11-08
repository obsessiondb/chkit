import { describe, test } from 'bun:test'

import { GRANULARITY_CHANGE, liveCutoverTarget, runRetryScenario } from './cutover-scenario.js'

// Each half of the statements fails in its own file, so the halves run side by side.
describe('generate --cutover e2e (#202)', () => {
  test('cuts over an index_granularity change, resuming after a failure at every step of the first half (#511)', async () => {
    await runRetryScenario(liveCutoverTarget(), 'cutover_granularity1', GRANULARITY_CHANGE, 'first')
  }, 1_800_000)
})
