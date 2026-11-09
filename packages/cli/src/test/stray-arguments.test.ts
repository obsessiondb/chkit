import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { CLI_ENTRY, createFixture, runCli } from './testkit.test'

/** A fixture whose plugin reports every onInit, so a test can tell whether a hook ran. */
async function createProbeFixture() {
  const fixture = await createFixture()
  const probePath = join(fixture.dir, 'probe-plugin.ts')
  await writeFile(
    probePath,
    `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'probe', apiVersion: 1 },\n  commands: [{ name: 'echo', run({ args, print }) { print(args.join(',')) } }],\n  hooks: {\n    onInit({ command }) {\n      console.error('onInit ' + command)\n    },\n  },\n})\n`,
    'utf8',
  )
  await writeFile(
    fixture.configPath,
    `import { plugin } from '${probePath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
    'utf8',
  )
  // A user profile could add plugins (such as obsessiondb) whose hooks fail here.
  const run = (args: readonly string[]) =>
    runCli([...args, '--config', fixture.configPath], { HOME: fixture.dir, XDG_CONFIG_HOME: fixture.dir })
  return { ...fixture, run }
}

describe('stray arguments (#612)', () => {
  test('commands that take no arguments reject one before any hook runs, as chkit-py does', async () => {
    const fixture = await createProbeFixture()
    try {
      for (const [args, extra] of [
        [['generate', 'foo'], 'foo'],
        [['generate', '--dryrun', '-n', 'x', 'foo', 'bar'], 'foo bar'],
        [['migrate', 'prod', '--apply'], 'prod'],
        [['status', 'foo'], 'foo'],
        [['status', '-'], '-'],
        [['drift', 'foo'], 'foo'],
        [['check', '--table', 'app.users', 'foo'], 'foo'],
        [['-c', fixture.configPath, 'status', 'foo'], 'foo'],
      ] as const) {
        const result = fixture.run(args)
        expect([args, result.exitCode, result.stdout, result.stderr.trim()]).toEqual([
          args,
          1,
          '',
          `Got unexpected extra argument(s) (${extra})`,
        ])
      }
      expect(existsSync(fixture.migrationsDir)).toBe(false)
      expect(existsSync(fixture.metaDir)).toBe(false)

      // Under --json the usage envelope goes to stdout, as for an unknown flag.
      const json = fixture.run(['status', 'foo', 'bar', '--json'])
      expect([json.exitCode, json.stderr.trim()]).toEqual([1, 'Got unexpected extra argument(s) (foo bar)'])
      expect(JSON.parse(json.stdout)).toEqual({
        command: 'status',
        schemaVersion: 1,
        ok: false,
        error: { code: 'usage', message: 'Got unexpected extra argument(s) (foo bar)' },
      })

      // A flag error comes first, as click reports it first in chkit-py.
      const flagError = fixture.run(['migrate', 'foo', '--bogus'])
      expect([flagError.exitCode, flagError.stderr.trim()]).toEqual([1, 'Unknown flag: --bogus'])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('commands that take positionals keep them', async () => {
    const fixture = await createProbeFixture()
    try {

      const rebuild = fixture.run(['snapshot', 'rebuild', 'foo'])
      expect([rebuild.exitCode, rebuild.stderr]).toEqual([
        1,
        expect.stringContaining('Unexpected argument "foo" for `chkit snapshot rebuild`.'),
      ])
      const dryrun = fixture.run(['snapshot', 'rebuild', '--dryrun'])
      expect(dryrun.exitCode).toBe(0)

      const query = fixture.run(['query', 'SELECT 1', 'extra'])
      expect([query.exitCode, query.stderr]).toEqual([1, expect.stringContaining('query accepts a single SQL string.')])

      // Both plugin routes pass the args after the command name (#624).
      for (const [args, printed] of [
        [['plugin', 'probe', 'echo', 'a', 'b'], 'a,b'],
        [['probe', 'echo', 'a', 'b'], 'a,b'],
      ] as const) {
        const result = fixture.run(args)
        expect([args, result.exitCode, result.stdout.trim()]).toEqual([args, 0, printed])
      }
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 60_000)
})
