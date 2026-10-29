import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { spawnWithTimeout } from './spawn-cli.js'
import { WORKSPACE_ROOT, createFixture } from './testkit.test'

const ITEM_COUNT = 1000
const BIG_TEXT = Array.from({ length: ITEM_COUNT }, (_, i) => `${i} ${'x'.repeat(100)}`).join('\n')

// Prints about 145 KB of JSON (`ok`, `fail`) or about 105 KB of text
// (`text-ok`, `text-fail`), well past the 64 KiB pipe buffer, touches
// `printedMarker`, then exits 0 or 1. A plain object (what `definePlugin`
// returns) so Node loads it through jiti without the CLI sources.
function renderBigPlugin(printedMarker: string): string {
  return `import { writeFileSync } from 'node:fs'

const big = { items: Array.from({ length: ${ITEM_COUNT} }, (_, i) => ({ i, pad: 'x'.repeat(100) })) }
const text = Array.from({ length: ${ITEM_COUNT} }, (_, i) => i + ' ' + 'x'.repeat(100)).join('\\n')

export const plugin = {
  manifest: { name: 'big', apiVersion: 1 },
  commands: [
    { name: 'ok', description: 'big output, exit 0', run({ print }) { print(big); writeFileSync('${printedMarker}', ''); return 0 } },
    { name: 'fail', description: 'big output, exit 1', run({ print }) { print(big); writeFileSync('${printedMarker}', ''); return 1 } },
    { name: 'text-ok', description: 'big text, exit 0', run({ print }) { print(text); writeFileSync('${printedMarker}', ''); return 0 } },
    { name: 'text-fail', description: 'big text, exit 1', run({ print }) { print(text); writeFileSync('${printedMarker}', ''); return 1 } },
  ],
}
`
}

// Writes the fixture plugin and a config that registers it.
async function writeBigPluginConfig(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  printedMarker: string
): Promise<void> {
  const pluginPath = join(fixture.dir, 'big-plugin.ts')
  await writeFile(pluginPath, renderBigPlugin(printedMarker), 'utf8')
  await writeFile(
    fixture.configPath,
    `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
    'utf8'
  )
}

const BUN_ENTRY = 'bun ./packages/cli/src/bin/chkit.ts'
const NODE_ENTRY = 'node ./packages/cli/dist/bin/chkit.js'

// Bun runs the sources. Node runs the published entry, which `test` builds
// first (packages/cli/turbo.json); under Node only a non-zero exit lost output.
const SLOW_READER_CASES = [
  { runtime: 'bun', entry: BUN_ENTRY, subcommand: 'ok', exitCode: 0 },
  { runtime: 'bun', entry: BUN_ENTRY, subcommand: 'fail', exitCode: 1 },
  { runtime: 'node', entry: NODE_ENTRY, subcommand: 'fail', exitCode: 1 },
] as const

// Runs `cli` piped to a reader that waits until the command has printed,
// then until the CLI exits (at most 2 s more: a fixed CLI waits for the reader
// to drain the pipe), so anything the CLI did not hand to the pipe before
// exiting is lost. The pipeline's status is cat's, so the CLI's own exit code
// goes to stderr, which must hold nothing else (a CLI that could not start
// shows its error here).
function runThroughSlowReader(cli: string, printedMarker: string, exitedMarker: string) {
  const waitFor = `waitFor() { i=0; while [ ! -e "$1" ] && [ $i -lt $2 ]; do sleep 0.1; i=$((i+1)); done; }`
  return spawnWithTimeout(
    [
      'sh',
      '-c',
      `${waitFor}; { ${cli}; echo "cli-exit=$?" >&2; touch '${exitedMarker}'; } | { waitFor '${printedMarker}' 300; waitFor '${exitedMarker}' 20; cat; }`,
    ],
    { cwd: WORKSPACE_ROOT }
  )
}

describe('output through a slow pipe reader', () => {
  for (const { runtime, entry, subcommand, exitCode } of SLOW_READER_CASES) {
    test(`${runtime}: plugin command exiting ${exitCode} writes the whole --json payload`, async () => {
      const fixture = await createFixture()
      const printedMarker = join(fixture.dir, 'printed')
      try {
        await writeBigPluginConfig(fixture, printedMarker)

        const cli = `${entry} plugin big ${subcommand} --json --config '${fixture.configPath}'`
        const result = runThroughSlowReader(cli, printedMarker, join(fixture.dir, 'exited'))

        expect(result.stderr).toBe(`cli-exit=${exitCode}\n`)
        expect(result.stdout.length).toBeGreaterThan(100_000)
        const payload = JSON.parse(result.stdout) as { items: unknown[] }
        expect(payload.items).toHaveLength(ITEM_COUNT)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    })

    test(`${runtime}: plugin command exiting ${exitCode} writes the whole text output`, async () => {
      const fixture = await createFixture()
      const printedMarker = join(fixture.dir, 'printed')
      try {
        await writeBigPluginConfig(fixture, printedMarker)

        const cli = `${entry} plugin big text-${subcommand} --config '${fixture.configPath}'`
        const result = runThroughSlowReader(cli, printedMarker, join(fixture.dir, 'exited'))

        expect(result.stderr).toBe(`cli-exit=${exitCode}\n`)
        // The text comes last; a logged-in ObsessionDB session may print a
        // notice before it.
        expect(result.stdout).toEndWith(`${BIG_TEXT}\n`)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    })
  }
})

const EARLY_CLOSE_CASES = [
  { runtime: 'bun', entry: BUN_ENTRY, subcommand: 'ok', exitCode: 0 },
  { runtime: 'bun', entry: BUN_ENTRY, subcommand: 'fail', exitCode: 1 },
  { runtime: 'node', entry: NODE_ENTRY, subcommand: 'ok', exitCode: 0 },
  { runtime: 'node', entry: NODE_ENTRY, subcommand: 'fail', exitCode: 1 },
] as const

const OUTPUT_MODES = [
  { mode: '--json', command: (subcommand: string) => `${subcommand} --json` },
  { mode: 'text', command: (subcommand: string) => `text-${subcommand}` },
] as const

describe('output to a reader that closes early', () => {
  for (const { runtime, entry, subcommand, exitCode } of EARLY_CLOSE_CASES) {
    for (const { mode, command } of OUTPUT_MODES) {
      test(`${runtime}: ${mode} plugin command exiting ${exitCode} keeps its exit code without an EPIPE crash`, async () => {
        const fixture = await createFixture()
        try {
          await writeBigPluginConfig(fixture, join(fixture.dir, 'printed'))

          // `head` closes the pipe while most of the output is still unwritten.
          const cli = `${entry} plugin big ${command(subcommand)} --config '${fixture.configPath}'`
          const result = spawnWithTimeout(
            ['sh', '-c', `{ ${cli}; echo "cli-exit=$?" >&2; } | head -c 50`],
            { cwd: WORKSPACE_ROOT }
          )

          expect(result.stderr).not.toContain('EPIPE')
          expect(result.stderr).toBe(`cli-exit=${exitCode}\n`)
          expect(result.stdout).toHaveLength(50)
        } finally {
          await rm(fixture.dir, { recursive: true, force: true })
        }
      })
    }
  }
})
