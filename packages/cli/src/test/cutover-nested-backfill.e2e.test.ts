import { describe, test } from 'bun:test'

import { liveCutoverTarget, runBackfillScenario } from './cutover-scenario.js'

describe('generate --cutover e2e (#859)', () => {
  test('copies flattened Nested rows through the backfill plugin while the mirror is live', async () => {
    await runBackfillScenario(liveCutoverTarget(), 'cutover_backfill_nested', true)
  }, 900_000)
})
