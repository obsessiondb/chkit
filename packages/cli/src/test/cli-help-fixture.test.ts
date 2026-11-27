import { readFile } from 'node:fs/promises'

import { expect, test } from 'bun:test'

import { CLI_HELP_FIXTURE, renderCliHelp } from './cli-help-cases.js'

// chkit-py's help is diffed against this fixture, so it must be the help this
// CLI prints. After a help change: bun run scripts/update-cli-help-fixture.ts
test('test/fixtures/cli-help.json is the help the CLI prints', async () => {
  const fixture: unknown = JSON.parse(await readFile(CLI_HELP_FIXTURE, 'utf8'))
  expect(await renderCliHelp()).toEqual(fixture)
}, 180_000)
