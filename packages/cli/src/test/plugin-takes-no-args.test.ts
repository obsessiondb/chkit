import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI_ENTRY, CODEGEN_PLUGIN_ENTRY, createFixture, runCli, WORKSPACE_ROOT } from './testkit.test'

const OBSESSIONDB_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-obsessiondb/src/index.ts')

function extraArgs(args: string): string {
  return `Got unexpected extra argument(s) (${args})`
}

/**
 * The real obsessiondb and codegen command definitions, with a `run` that
 * prints the call instead of logging in or writing files, beside a
 * third-party command that does not set `takesArgs`.
 */
async function createNoArgsFixture() {
  const fixture = await createFixture()
  const home = await mkdtemp(join(tmpdir(), 'chkit-no-args-home-'))
  const pluginsPath = join(fixture.dir, 'no-args-plugins.ts')
  await writeFile(
    pluginsPath,
    `import { definePlugin } from '${CLI_ENTRY}'
import { obsessiondb } from '${OBSESSIONDB_PLUGIN_ENTRY}'
import { codegen } from '${CODEGEN_PLUGIN_ENTRY}'

const hooks = {
  onInit({ command }) { console.error('onInit ' + command) },
  onComplete({ command }) { console.error('onComplete ' + command) },
}

function stubbed(real, withHooks) {
  return {
    manifest: real.manifest,
    hooks: withHooks ? hooks : undefined,
    commands: real.commands.map((command) => ({
      ...command,
      run({ args }) {
        console.log('RAN ' + command.name + ' ' + JSON.stringify(args))
        return 0
      },
    })),
  }
}

export const odb = stubbed(obsessiondb().plugin, true)
export const cg = stubbed(codegen().plugin, false)
export const echoer = definePlugin({
  manifest: { name: 'echoer', apiVersion: 1 },
  commands: [
    { name: 'echo', run({ args }) { console.log('RAN echo ' + JSON.stringify(args)) } },
    { name: 'boom', run() { throw new Error('kaput') } },
  ],
})
`,
    'utf8',
  )
  await writeFile(
    fixture.configPath,
    `import { odb, cg, echoer } from '${pluginsPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin: odb }, { plugin: cg }, { plugin: echoer }],\n}\n`,
    'utf8',
  )
  // Offline even if a command ran: no profile, and an API nothing listens on.
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    OBSESSIONDB_API_URL: 'http://127.0.0.1:9',
    BROWSER: '/usr/bin/false',
  }
  return {
    ...fixture,
    run: (args: string[]) => runCli(args, env),
    async cleanup() {
      await rm(fixture.dir, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    },
  }
}

describe('a plugin command with takesArgs: false rejects arguments (#659)', () => {
  test('obsessiondb auth commands and codegen reject any argument before they run, in every form', async () => {
    const fixture = await createNoArgsFixture()
    try {
      const c = ['--config', fixture.configPath]
      const cases: Array<[string[], string]> = [
        [['plugin', ...c, '--', 'obsessiondb', 'login', '-h'], '-h'],
        [['plugin', ...c, 'obsessiondb', '--', 'login', '-h'], '-h'],
        [['obsessiondb', ...c, '--', 'login', '-h'], '-h'],
        [['obsessiondb', 'login', ...c, '--', '-h'], '-h'],
        [['obsessiondb', 'login', 'extra', ...c], 'extra'],
        [['plugin', 'obsessiondb', 'login', 'extra', ...c], 'extra'],
        [['obsessiondb', 'login', ...c, '--', '-h', '--json'], '-h --json'],
        [['obsessiondb', 'signup', ...c, '--', '-h'], '-h'],
        [['obsessiondb', 'signup', 'x', ...c], 'x'],
        [['obsessiondb', 'whoami', ...c, '--', '-h'], '-h'],
        [['obsessiondb', 'whoami', 'whoami', ...c], 'whoami'],
        [['obsessiondb', 'logout', ...c, '--', '-h'], '-h'],
        [['plugin', ...c, 'obsessiondb', 'logout', '--', '--help'], '--help'],
        [['codegen', ...c, '--', '-h'], '-h'],
        [['codegen', 'codegen', ...c], 'codegen'],
        [['plugin', ...c, '--', 'codegen', 'codegen', '-h'], '-h'],
      ]
      for (const [args, rest] of cases) {
        const result = fixture.run(args)
        // No RAN on stdout and no hook on stderr: neither the command nor onInit ran.
        expect([args, result.exitCode, result.stdout, result.stderr.trim()]).toEqual([args, 1, '', extraArgs(rest)])
      }
    } finally {
      await fixture.cleanup()
    }
  }, 60_000)

  test('under --json the usage envelope names the command typed', async () => {
    const fixture = await createNoArgsFixture()
    try {
      const c = ['--config', fixture.configPath]
      const cases: Array<[string[], string, string]> = [
        [['--json', 'plugin', ...c, '--', 'obsessiondb', 'login', '-h'], 'plugin', '-h'],
        [['plugin', '--json', ...c, 'obsessiondb', '--', 'login', '-h'], 'plugin', '-h'],
        [['plugin', ...c, 'obsessiondb', 'login', '--json', 'extra'], 'plugin', 'extra'],
        [['--json', 'obsessiondb', ...c, '--', 'login', '-h'], 'obsessiondb', '-h'],
        [['obsessiondb', 'login', '--json', ...c, '--', '-h'], 'obsessiondb', '-h'],
        [['obsessiondb', 'signup', '--json', ...c, '--', '-h'], 'obsessiondb', '-h'],
        [['obsessiondb', 'whoami', '--json', 'extra', ...c], 'obsessiondb', 'extra'],
        [['codegen', '--json', ...c, '--', '-h'], 'codegen', '-h'],
      ]
      for (const [args, command, rest] of cases) {
        const result = fixture.run(args)
        expect([args, result.exitCode, result.stderr.trim()]).toEqual([args, 1, extraArgs(rest)])
        expect(JSON.parse(result.stdout)).toEqual({
          command,
          schemaVersion: 1,
          ok: false,
          error: { code: 'usage', message: extraArgs(rest) },
        })
      }
    } finally {
      await fixture.cleanup()
    }
  }, 60_000)

  test('without arguments the command runs, -- included', async () => {
    const fixture = await createNoArgsFixture()
    try {
      const c = ['--config', fixture.configPath]
      for (const [args, command, stdout] of [
        [['obsessiondb', ...c, '--', 'login'], 'obsessiondb', 'RAN login []'],
        [['obsessiondb', 'login', ...c, '--'], 'obsessiondb', 'RAN login []'],
        [['plugin', ...c, 'obsessiondb', '--', 'login'], 'plugin', 'RAN login []'],
        [['plugin', ...c, '--', 'obsessiondb', 'whoami'], 'plugin', 'RAN whoami []'],
        [['codegen', ...c], 'codegen', 'RAN codegen []'],
      ] as const) {
        const result = fixture.run([...args])
        expect([args, result.exitCode, result.stdout.trim()]).toEqual([args, 0, stdout])
        expect(result.stderr.trim().split('\n')).toEqual([`onInit ${command}`, `onComplete ${command}`])
      }
    } finally {
      await fixture.cleanup()
    }
  }, 60_000)

  test('a command that does not set takesArgs keeps getting its arguments', async () => {
    const fixture = await createNoArgsFixture()
    try {
      const c = ['--config', fixture.configPath]
      for (const args of [
        ['echoer', 'echo', 'x', ...c, '--', '-h'],
        ['plugin', ...c, 'echoer', 'echo', 'x', '--', '-h'],
        ['plugin', ...c, '--', 'echoer', 'echo', 'x', '-h'],
      ]) {
        const result = fixture.run(args)
        expect([args, result.exitCode, result.stdout.trim()]).toEqual([args, 0, 'RAN echo ["x","-h"]'])
      }
      // The obsessiondb service command reads its arguments and does not set it.
      const service = fixture.run(['obsessiondb', 'service', 'alias', 'list', ...c])
      expect([service.exitCode, service.stdout.trim()]).toEqual([0, 'RAN service ["alias","list"]'])
    } finally {
      await fixture.cleanup()
    }
  }, 60_000)

  test('a failing plugin command is named in the error, as in chkit-py', async () => {
    const fixture = await createNoArgsFixture()
    try {
      const result = fixture.run(['plugin', '--config', fixture.configPath, 'echoer', 'boom'])
      expect([result.exitCode, result.stderr.trim().split('\n').at(-1)]).toEqual([
        1,
        'Plugin "echoer" failed in command:boom: kaput',
      ])
    } finally {
      await fixture.cleanup()
    }
  }, 60_000)
})
