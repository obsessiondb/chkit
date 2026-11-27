import { describe, test } from 'bun:test'

import { liveCutoverTarget, runKeepScenario } from './cutover-scenario.js'

// A table with a Nested column stored flattened (#859), in its own file so
// `bun test --parallel` runs it beside the other cutover scenarios.
describe('generate --cutover e2e (#859)', () => {
  test('keeps flattened Nested rows while writers insert during the cutover', async () => {
    await runKeepScenario(liveCutoverTarget(), 'cutover_keep_nested', true)
  }, 900_000)
})
