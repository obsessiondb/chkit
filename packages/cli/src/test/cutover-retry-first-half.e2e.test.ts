import { describe, test } from 'bun:test'

import { liveCutoverTarget, runRetryScenario } from './cutover-scenario.js'

// Each half of the statements fails in its own file, so the halves run side by side.
describe('generate --cutover e2e (#202)', () => {
  test('resumes after a failure at every step of the first half and never replays the swap', async () => {
    await runRetryScenario(liveCutoverTarget(), 'cutover_retry1', undefined, 'first')
  }, 1_800_000)
})
