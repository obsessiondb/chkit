import { describe, test } from 'bun:test'

import { liveCutoverTarget, runRetryScenario } from './cutover-scenario.js'

describe('generate --cutover e2e (#202)', () => {
  test('resumes after a failure at every step of the second half and never replays the swap', async () => {
    await runRetryScenario(liveCutoverTarget(), 'cutover_retry2', undefined, 'second')
  }, 1_800_000)
})
