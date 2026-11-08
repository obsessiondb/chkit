import { describe, test } from 'bun:test'

import { liveCutoverTarget, runRetryScenario } from './cutover-scenario.js'

describe('generate --cutover e2e (#202)', () => {
  test('resumes after a failure at every step and never replays the swap', async () => {
    await runRetryScenario(liveCutoverTarget(), 'cutover_retry')
  }, 1_800_000)
})
