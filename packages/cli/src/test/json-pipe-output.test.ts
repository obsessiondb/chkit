import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { spawnWithTimeout } from './spawn-cli.js'
import { CLI_ENTRY, WORKSPACE_ROOT, createFixture } from './testkit.test'

const ITEM_COUNT = 1000

// Prints about 145 KB of JSON, well past the 64 KiB pipe buffer, touches
// `printedMarker`, then exits 0 or 1.
function renderBigPlugin(printedMarker: string): string {
  return `import { writeFileSync } from 'node:fs'
import { definePlugin } from '${CLI_ENTRY}'

const big = { items: Array.from({ length: ${ITEM_COUNT} }, (_, i) => ({ i, pad: 'x'.repeat(100) })) }

export const plugin = definePlugin({
  manifest: { name: 'big', apiVersion: 1 },
  commands: [
    { name: 'ok', description: 'big output, exit 0', run({ print }) { print(big); writeFileSync('${printedMarker}', ''); return 0 } },
    { name: 'fail', description: 'big output, exit 1', run({ print }) { print(big); writeFileSync('${printedMarker}', ''); return 1 } },
  ],
})
`
}

describe('--json output through a slow pipe reader', () => {
  for (const [subcommand, exitCode] of [['ok', 0], ['fail', 1]] as const) {
    test(`plugin command exiting ${exitCode} writes the whole payload`, async () => {
      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'big-plugin.ts')
      const printedMarker = join(fixture.dir, 'printed')
      const exitedMarker = join(fixture.dir, 'exited')
      try {
        await writeFile(pluginPath, renderBigPlugin(printedMarker), 'utf8')
        await writeFile(
          fixture.configPath,
          `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
          'utf8'
        )

        // The reader waits until the command has printed, then until the CLI
        // exits (at most 2 s more: a fixed CLI waits for the reader to drain
        // the pipe), so anything the CLI did not hand to the pipe before
        // exiting is lost. The pipeline's status is cat's, so the CLI's own
        // exit code goes to stderr.
        const cli = `bun ./packages/cli/src/bin/chkit.ts plugin big ${subcommand} --json --config '${fixture.configPath}'`
        const waitFor = `waitFor() { i=0; while [ ! -e "$1" ] && [ $i -lt $2 ]; do sleep 0.1; i=$((i+1)); done; }`
        const result = spawnWithTimeout(
          [
            'sh',
            '-c',
            `${waitFor}; { ${cli}; echo "cli-exit=$?" >&2; touch '${exitedMarker}'; } | { waitFor '${printedMarker}' 300; waitFor '${exitedMarker}' 20; cat; }`,
          ],
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
