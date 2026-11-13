import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { type SpawnResult, spawnWithTimeout } from './spawn-cli.js'
import { CLI_ENTRY, createFixture, WORKSPACE_ROOT } from './testkit.test.js'

const entry = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chkit.ts')

/** A directory with no project config and an empty user config dir, unless `profile` gives one. */
async function createEmptyDir({ profile }: { profile?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-arg-errors-'))
  if (profile !== undefined) {
    await mkdir(join(dir, 'chkit'), { recursive: true })
    await writeFile(join(dir, 'chkit', 'config.ts'), profile)
  }
  const run = (args: readonly string[]) =>
    spawnWithTimeout(['bun', entry, ...args], { cwd: dir, env: { HOME: dir, XDG_CONFIG_HOME: dir } })
  return { dir, run }
}

function usageResult(result: SpawnResult) {
  return [result.exitCode, result.stdout, result.stderr.trim()]
}

describe('argument errors come before a missing config, as in chkit-py (#687)', () => {
  test('commands that take no arguments report a stray argument, an unknown flag or a missing value', async () => {
    const { dir, run } = await createEmptyDir()
    try {
      for (const [args, message] of [
        [['status', 'foo'], 'Got unexpected extra argument(s) (foo)'],
        [['status', '--bogus'], 'Unknown flag: --bogus'],
        [['status', '--json=1'], 'Unknown flag: --json=1'],
        [['status', '--', 'foo'], 'Got unexpected extra argument(s) (foo)'],
        [['generate', '--name'], 'Missing value for --name'],
        [['generate', '--dryrun', 'foo'], 'Got unexpected extra argument(s) (foo)'],
        [['migrate', '--table'], 'Missing value for --table'],
        [['migrate', 'prod', '--apply'], 'Got unexpected extra argument(s) (prod)'],
        [['drift', 'foo'], 'Got unexpected extra argument(s) (foo)'],
        [['check', '-t'], 'Missing value for --table'],
        // The ObsessionDB flags count, as `chkit obsessiondb login` adds them.
        [['status', '--service', 'prod', 'foo'], 'Got unexpected extra argument(s) (foo)'],
        [['status', '--service', 'prod', '--bogus'], 'Unknown flag: --bogus'],
        [['status', '--service'], 'Missing value for --service'],
        [['generate', '--no-shared-engines', '--name'], 'Missing value for --name'],
        [['check', '--service', 'prod', '-t'], 'Missing value for --table'],
      ] as const) {
        expect([args, ...usageResult(run(args))]).toEqual([args, 1, '', message])
      }

      for (const [args, message] of [
        [['status', 'foo', '--json'], 'Got unexpected extra argument(s) (foo)'],
        [['status', '--bogus', '--json'], 'Unknown flag: --bogus'],
      ] as const) {
        const result = run(args)
        expect([args, result.exitCode, result.stderr.trim()]).toEqual([args, 1, message])
        expect(JSON.parse(result.stdout)).toEqual({
          command: 'status',
          schemaVersion: 1,
          ok: false,
          error: { code: 'usage', message },
        })
      }

      const help = run(['status', 'foo', '--help'])
      expect([help.exitCode, help.stderr]).toEqual([0, ''])
      expect(help.stdout).toContain('chkit status [options]')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('commands that take arguments report a flag error', async () => {
    const { dir, run } = await createEmptyDir()
    try {
      for (const [args, message] of [
        [['query', '--bogus', 'SELECT 1'], 'Unknown flag: --bogus'],
        [['snapshot', 'rebuild', '--bogus'], 'Unknown flag: --bogus'],
        [['snapshot', 'rebuild', '--table'], 'Missing value for --table'],
      ] as const) {
        expect([args, ...usageResult(run(args))]).toEqual([args, 1, '', message])
      }
      // snapshot rebuild checks its own arguments once the config is loaded, as in chkit-py.
      const rebuild = run(['snapshot', 'rebuild', 'foo'])
      expect([rebuild.exitCode, rebuild.stderr]).toEqual([1, expect.stringContaining('Config not found at ')])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a user profile without a project config reports the argument error first', async () => {
    const { dir, run } = await createEmptyDir({ profile: 'export default { schema: [], plugins: [] }\n' })
    try {
      for (const [args, message] of [
        [['status', '--bogus'], 'Unknown flag: --bogus'],
        [['generate', '--bogus'], 'Unknown flag: --bogus'],
        [['drift', 'foo'], 'Got unexpected extra argument(s) (foo)'],
      ] as const) {
        expect([args, ...usageResult(run(args))]).toEqual([args, 1, '', message])
      }
      const status = run(['status'])
      expect([status.exitCode, status.stderr]).toEqual([1, expect.stringContaining('Command "status" requires a project config')])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('flags and commands that plugins add need the config', async () => {
    const empty = await createEmptyDir()
    try {
      // The config names the plugins. Outside a project, a plugin command and
      // a valid ObsessionDB flag report the missing config, as in chkit-py. A
      // flag that only another plugin adds is unknown.
      for (const args of [
        ['pull', '--bogus'],
        ['codegen', '--bogus'],
        ['plugin', '--bogus'],
        ['status', '--service', 'prod'],
        ['migrate', '--no-shared-engines'],
      ]) {
        const result = empty.run(args)
        expect([args, result.exitCode, result.stderr]).toEqual([args, 1, expect.stringContaining('Config not found at ')])
      }
      expect(usageResult(empty.run(['snapshot', 'rebuild', '--probe']))).toEqual([1, '', 'Unknown flag: --probe'])
    } finally {
      await rm(empty.dir, { recursive: true, force: true })
    }

    // With a project config, the arguments are checked once its plugins are
    // loaded, so a config that fails to load reports its own error first.
    const broken = await createFixture()
    try {
      await writeFile(broken.configPath, `throw new Error('CONFIG FAILED'); export default {}`)
      const result = spawnWithTimeout(['bun', entry, 'status', 'foo'], {
        cwd: broken.dir,
        env: { HOME: broken.dir, XDG_CONFIG_HOME: broken.dir },
      })
      expect([result.exitCode, result.stderr]).toEqual([1, expect.stringContaining('CONFIG FAILED')])
    } finally {
      await rm(broken.dir, { recursive: true, force: true })
    }

    const fixture = await createFixture()
    try {
      const probePath = join(fixture.dir, 'probe-plugin.ts')
      await writeFile(
        probePath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'probe', apiVersion: 1 },\n  extendCommands: [{ command: 'snapshot', flags: [{ name: '--probe', type: 'boolean', description: 'Probe' }] }],\n  hooks: {\n    onInit({ flags }) {\n      console.error('probe ' + String(flags['--probe']))\n    },\n  },\n})\n`,
      )
      await writeFile(
        fixture.configPath,
        `import { plugin } from '${probePath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
      )
      const result = spawnWithTimeout(['bun', entry, 'snapshot', 'rebuild', '--dryrun', '--probe'], {
        cwd: fixture.dir,
        env: { HOME: fixture.dir, XDG_CONFIG_HOME: fixture.dir },
      })
      expect([result.exitCode, result.stderr]).toEqual([0, expect.stringContaining('probe true')])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 60_000)
})
