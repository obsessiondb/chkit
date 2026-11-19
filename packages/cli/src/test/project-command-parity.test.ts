import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { spawnWithTimeout } from './spawn-cli.js'
import { createFixture, PULL_PLUGIN_ENTRY, WORKSPACE_ROOT } from './testkit.test.js'

const entry = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chkit.ts')
const OBSESSIONDB_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-obsessiondb/src/index.ts')
const NO_TARGET = 'pull needs a target: set CLICKHOUSE_URL or select an ObsessionDB service (chkit obsessiondb service select)'

/**
 * A project whose config registers `plugins`, run without a ClickHouse target
 * and with an empty user config dir, so no profile or login reaches it.
 */
async function createProject(plugins: { imports: string; list: string } = { imports: '', list: '' }) {
  const fixture = await createFixture()
  await writeFile(
    fixture.configPath,
    `${plugins.imports}export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [${plugins.list}],\n}\n`,
  )
  const home = await mkdtemp(join(tmpdir(), 'chkit-project-parity-home-'))
  const run = (args: readonly string[]) =>
    spawnWithTimeout(['bun', entry, ...args], {
      cwd: fixture.dir,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: home,
        CLICKHOUSE_URL: undefined,
        CLICKHOUSE_HOST: undefined,
        CLICKHOUSE_PASSWORD: undefined,
      },
    })
  const cleanup = async () => {
    await rm(fixture.dir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
  return { configPath: fixture.configPath, run, cleanup }
}

const withObsessionDB = {
  imports: `import { obsessiondb } from '${OBSESSIONDB_PLUGIN_ENTRY}'\n`,
  list: 'obsessiondb()',
}

describe('commands in a project match chkit-py (#776)', () => {
  test('obsessiondb reads its first argument as the command name, with the plugin absent or registered', async () => {
    for (const plugins of [undefined, withObsessionDB]) {
      const project = await createProject(plugins)
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
          const text = project.run(args)
          expect([args, text.exitCode, text.stderr.trim()]).toEqual([args, 1, message])
          expect(text.stdout).toContain('chkit obsessiondb <command> [options]')
          // After `--`, --json is an argument, not an option.
          const jsonForms = [['obsessiondb', '--json', ...args.slice(1)], ...(args.includes('--') ? [] : [[...args, '--json']])]
          for (const jsonArgs of jsonForms) {
            const json = project.run(jsonArgs)
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
          const help = project.run(args)
          expect([args, help.exitCode, help.stderr]).toEqual([args, 0, ''])
          expect(help.stdout).toContain('chkit obsessiondb <command> [options]')
        }
        // Guard: --json and --config before the command name still run it.
        const notLoggedIn = 'Not logged in. Run `chkit obsessiondb login` to authenticate.'
        for (const args of [
          ['obsessiondb', 'whoami'],
          ['obsessiondb', '--config', project.configPath, 'whoami'],
          ['obsessiondb', '-c', project.configPath, 'whoami'],
        ]) {
          const result = project.run(args)
          expect([args, result.exitCode, result.stdout.trim(), result.stderr]).toEqual([args, 1, notLoggedIn, ''])
        }
        const whoamiJson = project.run(['obsessiondb', '--json', 'whoami'])
        expect([whoamiJson.exitCode, whoamiJson.stderr]).toEqual([1, ''])
        expect(JSON.parse(whoamiJson.stdout)).toMatchObject({ command: 'obsessiondb whoami', error: { code: 'not_logged_in' } })
      } finally {
        await project.cleanup()
      }
    }
  }, 120_000)

  test('codegen and pull print their help without the plugin in the config', async () => {
    const project = await createProject()
    try {
      for (const [args, usage] of [
        [['codegen', '--help'], 'chkit codegen [options]'],
        [['codegen', '-h'], 'chkit codegen [options]'],
        [['codegen', '--help', '--json'], 'chkit codegen [options]'],
        [['codegen', '--help-plugins'], 'chkit codegen [options]'],
        [['pull', '--help'], 'chkit pull <command> [options]'],
        [['pull', '--help', '--json'], 'chkit pull <command> [options]'],
        [['pull', '--help-plugins'], 'chkit pull <command> [options]'],
      ] as const) {
        const help = project.run(args)
        expect([args, help.exitCode, help.stderr]).toEqual([args, 0, ''])
        expect(help.stdout).toContain(usage)
      }
      // Guard: codegen still needs the plugin to run, as in chkit-py.
      const message = 'Codegen plugin is not configured. Add it to config.plugins first.'
      const codegen = project.run(['codegen'])
      expect([codegen.exitCode, codegen.stdout, codegen.stderr.trim()]).toEqual([1, '', message])
      const codegenJson = project.run(['codegen', '--json'])
      expect([codegenJson.exitCode, codegenJson.stderr.trim()]).toEqual([1, message])
      expect(JSON.parse(codegenJson.stdout)).toEqual({
        command: 'codegen',
        schemaVersion: 1,
        ok: false,
        error: { code: 'plugin_not_configured', message },
      })
    } finally {
      await project.cleanup()
    }
  }, 60_000)

  test('pull runs without the plugin in the config, as a built-in command in chkit-py', async () => {
    const absent = await createProject()
    const registered = await createProject({
      imports: `import { pull } from '${PULL_PLUGIN_ENTRY}'\n`,
      list: 'pull()',
    })
    try {
      for (const project of [absent, registered]) {
        for (const args of [['pull'], ['pull', '--dryrun']]) {
          const text = project.run(args)
          expect([args, text.exitCode, text.stdout.trim(), text.stderr]).toEqual([args, 2, `Pull schema failed: ${NO_TARGET}`, ''])
        }
        const json = project.run(['pull', '--dryrun', '--json'])
        expect([json.exitCode, json.stderr]).toEqual([2, ''])
        expect(JSON.parse(json.stdout)).toEqual({ ok: false, command: 'schema', error: NO_TARGET })
        for (const [args, message] of [
          [['pull', '--bogus'], 'Unknown flag: --bogus'],
          [['pull', 'foo'], 'Got unexpected extra argument(s) (foo)'],
        ] as const) {
          const text = project.run(args)
          expect([args, text.exitCode, text.stdout, text.stderr.trim()]).toEqual([args, 1, '', message])
          const usage = project.run([...args, '--json'])
          expect([args, usage.exitCode, usage.stderr.trim()]).toEqual([args, 1, message])
          expect(JSON.parse(usage.stdout)).toEqual({ command: 'pull', schemaVersion: 1, ok: false, error: { code: 'usage', message } })
        }
      }
    } finally {
      await absent.cleanup()
      await registered.cleanup()
    }
  }, 120_000)

  test('plugin pull runs without the plugin in the config, as in chkit-py (#771)', async () => {
    const projects = [
      await createProject(),
      await createProject(withObsessionDB),
      await createProject({ imports: `import { pull } from '${PULL_PLUGIN_ENTRY}'\n`, list: 'pull()' }),
    ]
    const description = 'Pull live ClickHouse table schema and write chkit schema file'
    try {
      for (const project of projects) {
        const listed = project.run(['plugin', 'pull'])
        expect([listed.exitCode, listed.stdout.trim(), listed.stderr]).toEqual([
          0,
          `Plugin commands for "pull":\n- schema: ${description}`,
          '',
        ])
        const listedJson = project.run(['plugin', '--json', 'pull'])
        expect(JSON.parse(listedJson.stdout)).toEqual({
          command: 'plugin',
          schemaVersion: 1,
          plugin: 'pull',
          commands: [{ name: 'schema', description }],
        })
        const text = project.run(['plugin', 'pull', 'schema', '--dryrun'])
        expect([text.exitCode, text.stdout.trim(), text.stderr]).toEqual([2, `Pull schema failed: ${NO_TARGET}`, ''])
        const json = project.run(['plugin', 'pull', 'schema', '--dryrun', '--json'])
        expect([json.exitCode, json.stderr]).toEqual([2, ''])
        expect(JSON.parse(json.stdout)).toEqual({ ok: false, command: 'schema', error: NO_TARGET })
        const unknown = project.run(['plugin', 'pull', 'foo'])
        expect([unknown.exitCode, unknown.stderr.trim()]).toEqual([1, 'Unknown pull command "foo". Available: schema.'])
        const stray = project.run(['plugin', 'pull', 'schema', 'foo'])
        expect([stray.exitCode, stray.stderr.trim()]).toEqual([1, 'Got unexpected extra argument(s) (foo)'])
      }
      // Guard: only `chkit plugin pull` gets the fallback, not the plugin listing.
      const absent = projects[0]
      expect(absent?.run(['plugin']).stderr.trim()).toBe('No plugins configured. Add entries to config.plugins first.')
    } finally {
      for (const project of projects) await project.cleanup()
    }
  }, 180_000)

  test('a disabled pull plugin is still not configured', async () => {
    const project = await createProject({
      imports: `import { pull } from '${PULL_PLUGIN_ENTRY}'\n`,
      list: '{ ...pull(), enabled: false }',
    })
    try {
      const result = project.run(['pull'])
      expect([result.exitCode, result.stderr.trim()]).toEqual([1, 'Pull plugin is not configured. Add it to config.plugins first.'])
    } finally {
      await project.cleanup()
    }
  }, 60_000)

  test('a disabled obsessiondb plugin is not configured, and its help still prints', async () => {
    const project = await createProject({
      imports: withObsessionDB.imports,
      list: '{ ...obsessiondb(), enabled: false }',
    })
    try {
      const message = 'ObsessionDB plugin is not configured. Add it to config.plugins first.'
      for (const args of [['obsessiondb'], ['obsessiondb', 'login']]) {
        const result = project.run(args)
        expect([args, result.exitCode, result.stdout, result.stderr.trim()]).toEqual([args, 1, '', message])
      }
      for (const [args, usage] of [
        [['obsessiondb', '--help'], 'chkit obsessiondb <command> [options]'],
        [['obsessiondb', 'login', '--help'], 'chkit obsessiondb login [options]'],
      ] as const) {
        const help = project.run(args)
        expect([args, help.exitCode, help.stderr]).toEqual([args, 0, ''])
        expect(help.stdout).toContain(usage)
      }
    } finally {
      await project.cleanup()
    }
  }, 60_000)

  test('an unknown service subcommand prints one message', async () => {
    for (const plugins of [undefined, withObsessionDB]) {
      const project = await createProject(plugins)
      try {
        const message = 'Unknown service subcommand "nosuch".'
        const text = project.run(['obsessiondb', 'service', 'nosuch'])
        expect([text.exitCode, text.stdout, text.stderr]).toEqual([1, `${message}\n`, ''])
        const json = project.run(['obsessiondb', 'service', 'nosuch', '--json'])
        expect([json.exitCode, json.stderr]).toEqual([1, ''])
        expect(JSON.parse(json.stdout)).toEqual({ schemaVersion: 1, message })
      } finally {
        await project.cleanup()
      }
    }
    // Also outside a project.
    const dir = await mkdtemp(join(tmpdir(), 'chkit-project-parity-empty-'))
    try {
      const json = spawnWithTimeout(['bun', entry, 'obsessiondb', 'service', 'nosuch', '--json'], {
        cwd: dir,
        env: { HOME: dir, XDG_CONFIG_HOME: dir },
      })
      expect([json.exitCode, json.stderr]).toEqual([1, ''])
      expect(JSON.parse(json.stdout)).toEqual({ schemaVersion: 1, message: 'Unknown service subcommand "nosuch".' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
