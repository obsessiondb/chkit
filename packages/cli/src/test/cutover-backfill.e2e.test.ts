import { describe, test } from 'bun:test'

import { liveCutoverTarget, runBackfillScenario } from './cutover-scenario.js'

describe('generate --cutover e2e (#202)', () => {
  test('copies through the backfill plugin, then swaps and drops the old table', async () => {
    await runBackfillScenario(liveCutoverTarget(), 'cutover_backfill')
  }, 900_000)
})
