/**
 * Rewrite test/fixtures/cli-help.json, the TS CLI help that chkit-py's help is
 * diffed against, from the CLI's source.
 */
import { writeFile } from 'node:fs/promises'

import { CLI_HELP_FIXTURE, renderCliHelp } from '../packages/cli/src/test/cli-help-cases.js'

await writeFile(CLI_HELP_FIXTURE, `${JSON.stringify(await renderCliHelp(), null, 2)}\n`)
console.log(`Wrote ${CLI_HELP_FIXTURE}`)
