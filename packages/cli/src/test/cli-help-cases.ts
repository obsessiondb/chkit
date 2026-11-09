/**
 * The help the TS CLI prints, which `test/fixtures/cli-help.json` records for
 * chkit-py: `chkit_python/tests/test_cli_help_parity.py` diffs the Python
 * help against it (#619). `cli-help-fixture.test.ts` keeps the fixture
 * current; `bun run scripts/update-cli-help-fixture.ts` rewrites it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI_VERSION } from '../runtime/version.js'
import { spawnWithTimeout } from './spawn-cli.js'
import { CODEGEN_PLUGIN_ENTRY, PULL_PLUGIN_ENTRY, WORKSPACE_ROOT } from './testkit.test.js'

export const CLI_HELP_FIXTURE = join(WORKSPACE_ROOT, 'test/fixtures/cli-help.json')

const ENTRY = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chkit.ts')
const OBSESSIONDB_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-obsessiondb/src/index.ts')

const CORE_COMMANDS = ['generate', 'migrate', 'status', 'drift', 'check', 'snapshot', 'query', 'plugin']
const OBSESSIONDB_COMMANDS = ['login', 'signup', 'logout', 'whoami', 'service']

const CLI_HELP_CASES: string[][] = [
  ['--help'],
  ['init', '--help'],
  ...CORE_COMMANDS.map((command) => [command, '--help']),
  ...CORE_COMMANDS.map((command) => [command, '--help-plugins']),
  ['codegen', '--help'],
  ['pull', 'schema', '--help'],
  ['obsessiondb', '--help'],
  ...OBSESSIONDB_COMMANDS.map((command) => ['obsessiondb', command, '--help']),
]

// The plugins chkit-py also has (pull is a built-in command there).
const CONFIG = `import { codegen } from ${JSON.stringify(CODEGEN_PLUGIN_ENTRY)}
import { obsessiondb } from ${JSON.stringify(OBSESSIONDB_PLUGIN_ENTRY)}
import { pull } from ${JSON.stringify(PULL_PLUGIN_ENTRY)}

export default { schema: [], plugins: [codegen(), pull(), obsessiondb()] }
`

/** Every case's stdout, keyed by its arguments, with the version as `{version}`. */
export async function renderCliHelp(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-cli-help-'))
  try {
    await writeFile(join(dir, 'clickhouse.config.ts'), CONFIG)
    const help: Record<string, string> = {}
    for (const args of CLI_HELP_CASES) {
      const result = spawnWithTimeout(['bun', ENTRY, ...args], {
        cwd: dir,
        // No user profile or debug output reaches the help.
        env: { HOME: dir, XDG_CONFIG_HOME: dir, CHKIT_DEBUG: undefined },
      })
      if (result.exitCode !== 0 || result.stderr !== '') {
        throw new Error(`chkit ${args.join(' ')} exited ${result.exitCode}: ${result.stderr}`)
      }
      help[args.join(' ')] = result.stdout.replaceAll(`v${CLI_VERSION}`, 'v{version}')
    }
    return help
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
