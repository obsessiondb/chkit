import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { spawnWithTimeout } from './spawn-cli.js'
import { CLI_ENTRY, WORKSPACE_ROOT, createFixture } from './testkit.test'

const ITEM_COUNT = 1000

// Prints over 100 KB of JSON, well past the 64 KiB pipe buffer, then exits 0 or 1.
function renderBigPlugin(): string {
  return `import { definePlugin } from '${CLI_ENTRY}'

const big = { items: Array.from({ length: ${ITEM_COUNT} }, (_, i) => ({ i, pad: 'x'.repeat(100) })) }

export const plugin = definePlugin({
  manifest: { name: 'big', apiVersion: 1 },
  commands: [
    { name: 'ok', description: 'big output, exit 0', run({ print }) { print(big); return 0 } },
    { name: 'fail', description: 'big output, exit 1', run({ print }) { print(big); return 1 } },
  ],
})
`
}

describe('--json output through a slow pipe reader', () => {
  for (const [subcommand, exitCode] of [['ok', 0], ['fail', 1]] as const) {
    test(`plugin command exiting ${exitCode} writes the whole payload`, async () => {
      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'big-plugin.ts')
      try {
        await writeFile(pluginPath, renderBigPlugin(), 'utf8')
        await writeFile(
          fixture.configPath,
          `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
          'utf8'
        )

        // The reader only starts once the CLI has had time to exit, so anything
        // the CLI did not hand to the pipe before exiting is lost. The pipeline's
        // status is cat's, so the CLI's own exit code goes to stderr.
        const cli = `bun ./packages/cli/src/bin/chkit.ts plugin big ${subcommand} --json --config '${fixture.configPath}'`
        const result = spawnWithTimeout(
          ['sh', '-c', `{ ${cli}; echo "cli-exit=$?" >&2; } | { sleep 2; cat; }`],
          { cwd: WORKSPACE_ROOT }
        )

        expect(result.stderr).toContain(`cli-exit=${exitCode}`)
        expect(result.stdout.length).toBeGreaterThan(100_000)
        const payload = JSON.parse(result.stdout) as { items: unknown[] }
        expect(payload.items).toHaveLength(ITEM_COUNT)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    })
  }
})
