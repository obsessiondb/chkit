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
        // `pull` is a built-in command in chkit-py.
        [['pull', 'foo'], 'Got unexpected extra argument(s) (foo)'],
        [['pull', '--bogus'], 'Unknown flag: --bogus'],
        [['pull', '-o'], 'Missing value for --out-file'],
      ] as const) {
        expect([args, ...usageResult(run(args))]).toEqual([args, 1, '', message])
      }

      for (const [args, message] of [
        [['status', 'foo', '--json'], 'Got unexpected extra argument(s) (foo)'],
        [['status', '--bogus', '--json'], 'Unknown flag: --bogus'],
        [['pull', 'foo', '--json'], 'Got unexpected extra argument(s) (foo)'],
      ] as const) {
        const result = run(args)
        expect([args, result.exitCode, result.stderr.trim()]).toEqual([args, 1, message])
        expect(JSON.parse(result.stdout)).toEqual({
          command: args[0],
          schemaVersion: 1,
          ok: false,
          error: { code: 'usage', message },
        })
      }

      for (const [args, usage] of [
        // Guard, unchanged by #687: --help already printed the help without a config.
        [['status', 'foo', '--help'], 'chkit status [options]'],
        [['status', '--help-plugins', 'foo'], 'chkit status [options]'],
        [['pull', '--help'], 'chkit pull <command> [options]'],
        [['pull', '--help-plugins'], 'chkit pull <command> [options]'],
        [['--help-plugins'], 'chkit <command> [options]'],
      ] as const) {
        const help = run(args)
        expect([args, help.exitCode, help.stderr]).toEqual([args, 0, ''])
        expect(help.stdout).toContain(usage)
      }
      // As in chkit-py, --help-plugins lists the flags that `chkit obsessiondb login` adds.
      expect(run(['status', '--help-plugins']).stdout).toContain('--service')
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
      for (const [args, message] of [
        [['query'], 'query requires a SQL string as the first positional argument (e.g. `chkit query "SELECT 1"`)'],
        [['query', 'SELECT', '1'], 'query accepts a single SQL string. Wrap it in quotes if it contains spaces.'],
      ] as const) {
        expect([args, ...usageResult(run(args))]).toEqual([args, 1, '', message])
        const json = run([...args, '--json'])
        expect([args, json.exitCode, json.stderr.trim()]).toEqual([args, 1, message])
        expect(JSON.parse(json.stdout)).toEqual({ command: 'query', schemaVersion: 1, ok: false, error: { code: 'error', message } })
      }
      // Guard, unchanged by #687: snapshot rebuild checks its own arguments once the config is loaded, as in chkit-py.
      const rebuild = run(['snapshot', 'rebuild', 'foo'])
      expect([rebuild.exitCode, rebuild.stderr]).toEqual([1, expect.stringContaining('Config not found at ')])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('an unknown command reports itself', async () => {
    const { dir, run } = await createEmptyDir()
    try {
      for (const args of [['nosuch'], ['nosuch', '--bogus'], ['nosuch', '--help'], ['nosuch', '--help-plugins']]) {
        const result = run(args)
        expect([args, result.exitCode, result.stderr.trim()]).toEqual([args, 1, 'Unknown command: nosuch'])
        expect(result.stdout).toContain('chkit <command> [options]')
      }
      const json = run(['nosuch', '--bogus', '--json'])
      expect([json.exitCode, json.stderr.trim()]).toEqual([1, 'Unknown command: nosuch'])
      expect(JSON.parse(json.stdout)).toEqual({
        command: 'nosuch',
        schemaVersion: 1,
        ok: false,
        error: { code: 'unknown_command', message: 'Unknown command: nosuch' },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a plugin command that chkit-py has no top-level command for is unknown', async () => {
    const { dir, run } = await createEmptyDir()
    try {
      // chkit-py runs these plugins only through `chkit plugin <name>`.
      for (const command of ['ingest', 'backfill', 'tinybird']) {
        const result = run([command, '--json'])
        expect([command, result.exitCode, result.stderr.trim()]).toEqual([command, 1, `Unknown command: ${command}`])
        expect(JSON.parse(result.stdout)).toEqual({
          command,
          schemaVersion: 1,
          ok: false,
          error: { code: 'unknown_command', message: `Unknown command: ${command}` },
        })
      }
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
        [['pull', 'foo'], 'Got unexpected extra argument(s) (foo)'],
      ] as const) {
        expect([args, ...usageResult(run(args))]).toEqual([args, 1, '', message])
      }
      // Guard, unchanged by #687: without an argument error, the project config is still required.
      const status = run(['status'])
      expect([status.exitCode, status.stderr]).toEqual([1, expect.stringContaining('Command "status" requires a project config')])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('codegen and pull print their help without a project config, as in chkit-py (#771)', async () => {
    const empty = await createEmptyDir()
    const profile = await createEmptyDir({ profile: 'export default { schema: [], plugins: [] }\n' })
    try {
      for (const { run } of [empty, profile]) {
        for (const [args, usage] of [
          [['codegen', '--help'], 'chkit codegen [options]'],
          [['codegen', '--help', '--json'], 'chkit codegen [options]'],
          [['codegen', '-h'], 'chkit codegen [options]'],
          [['codegen', '--help-plugins'], 'chkit codegen [options]'],
          [['codegen', '--help', '--config', 'missing.ts'], 'chkit codegen [options]'],
          [['pull', '--help'], 'chkit pull <command> [options]'],
          [['pull', '--help', '--json'], 'chkit pull <command> [options]'],
        ] as const) {
          const help = run(args)
          expect([args, help.exitCode, help.stderr]).toEqual([args, 0, ''])
          expect(help.stdout).toContain(usage)
        }
      }
      // A user profile that lists no plugins prints the help with the ObsessionDB
      // flags, as in chkit-py and as in an empty directory.
      const shared = ['--force-shared-engines', '--no-shared-engines']
      for (const [command, sections, flags] of [
        ['status', 2, [...shared, '--service']],
        ['generate', 2, [...shared, '--service']],
        ['migrate', 2, [...shared, '--service']],
        ['drift', 2, [...shared, '--service']],
        ['check', 2, [...shared, '--service']],
        ['snapshot', 1, shared],
        ['pull', 1, ['--service']],
        ['codegen', 0, []],
      ] as const) {
        for (const args of [[command, '--help-plugins'], [command, '--help-plugins', '--json']]) {
          const help = profile.run(args)
          expect([args, help.exitCode, help.stderr]).toEqual([args, 0, ''])
          expect(help.stdout).toContain(`chkit ${command} `)
          const shownSections = help.stdout.split('\n').filter((line) => line === 'Plugin: obsessiondb').length
          const shown = ['--force-shared-engines', '--no-shared-engines', '--service'].filter((flag) =>
            new RegExp(`^  ${flag}\\b`, 'm').test(help.stdout),
          )
          expect([args, shownSections, shown]).toEqual([args, sections, flags])
          expect([args, help.stdout]).toEqual([args, empty.run(args).stdout])
        }
      }
      // The ObsessionDB flags count as valid there too, as in chkit-py.
      for (const [args, message] of [
        [['status', '--service', 'prod', 'foo'], 'Got unexpected extra argument(s) (foo)'],
        [['status', '--service'], 'Missing value for --service'],
        [['generate', '--no-shared-engines', '--bogus'], 'Unknown flag: --bogus'],
      ] as const) {
        expect([args, ...usageResult(profile.run(args))]).toEqual([args, 1, '', message])
      }
      // Guard: codegen checks its arguments once the config is loaded, as in chkit-py.
      for (const args of [['codegen'], ['codegen', 'foo'], ['codegen', '--bogus'], ['codegen', '--bogus', '--json']]) {
        const result = empty.run(args)
        expect([args, result.exitCode, result.stderr]).toEqual([args, 1, expect.stringContaining('Config not found at ')])
      }
    } finally {
      await rm(empty.dir, { recursive: true, force: true })
      await rm(profile.dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('obsessiondb reads its first argument as the command name, as in chkit-py (#771)', async () => {
    const { dir, run } = await createEmptyDir()
    try {
      // As `chkit plugin obsessiondb ...`: only --json and --config are skipped.
      for (const [args, token] of [
        [['obsessiondb', '--bogus'], '--bogus'],
        [['obsessiondb', '--bogus=1'], '--bogus=1'],
        [['obsessiondb', '--bogus', 'login'], '--bogus'],
        [['obsessiondb', '--service', 'prod'], '--service'],
        [['obsessiondb', '--table', 'x'], '--table'],
        [['obsessiondb', '--', '--bogus'], '--bogus'],
        [['obsessiondb', 'nosuch'], 'nosuch'],
      ] as const) {
        const message = `Unknown obsessiondb command "${token}". Available: login, signup, logout, whoami, service.`
        const text = run(args)
        expect([args, text.exitCode, text.stderr.trim()]).toEqual([args, 1, message])
        expect(text.stdout).toContain('chkit obsessiondb <command> [options]')
        // After `--`, --json is an argument, not an option.
        const jsonForms = [['obsessiondb', '--json', ...args.slice(1)], ...(args.includes('--') ? [] : [[...args, '--json']])]
        for (const jsonArgs of jsonForms) {
          const json = run(jsonArgs)
          expect([jsonArgs, json.exitCode, json.stderr.trim()]).toEqual([jsonArgs, 1, message])
          expect(JSON.parse(json.stdout)).toEqual({
            command: 'obsessiondb',
            schemaVersion: 1,
            ok: false,
            error: { code: 'unknown_subcommand', message },
          })
        }
      }
      // Guard: without a command name, obsessiondb prints its help.
      for (const args of [['obsessiondb'], ['obsessiondb', '--json'], ['obsessiondb', '--help', '--bogus']]) {
        const help = run(args)
        expect([args, help.exitCode, help.stderr]).toEqual([args, 0, ''])
        expect(help.stdout).toContain('chkit obsessiondb <command> [options]')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a flag that only a plugin adds is unknown without a config', async () => {
    const { dir, run } = await createEmptyDir()
    try {
      expect(usageResult(run(['snapshot', 'rebuild', '--probe']))).toEqual([1, '', 'Unknown flag: --probe'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  // Guards: this behavior is the same before and after #687 and must not change.
  test('guard: plugin commands, plugin flags and a broken or plugin-extended project config are unchanged', async () => {
    const empty = await createEmptyDir()
    try {
      // The config names the plugins. Outside a project, a plugin command and
      // a valid ObsessionDB flag report the missing config, as in chkit-py.
      // Valid `pull` flags need the config too.
      for (const args of [
        ['pull', '--dryrun'],
        ['codegen', '--bogus'],
        ['plugin', '--bogus'],
        ['status', '--service', 'prod'],
        ['migrate', '--no-shared-engines'],
      ]) {
        const result = empty.run(args)
        expect([args, result.exitCode, result.stderr]).toEqual([args, 1, expect.stringContaining('Config not found at ')])
      }
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
