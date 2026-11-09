import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { spawnWithTimeout } from './spawn-cli.js'
import { CLI_ENTRY as CLI_SOURCE_ENTRY, CODEGEN_PLUGIN_ENTRY, createFixture, PULL_PLUGIN_ENTRY, renderScopedSchema, WORKSPACE_ROOT } from './testkit.test'

const CLI_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/dist/bin/chkit.js')

function runCli(args: string[], fixtureDir?: string) {
  // An empty XDG_CONFIG_HOME keeps a developer's ObsessionDB login out of the run.
  const env = fixtureDir ? { XDG_CONFIG_HOME: join(fixtureDir, 'xdg') } : undefined
  return spawnWithTimeout(['node', CLI_ENTRY, ...args], { cwd: WORKSPACE_ROOT, env })
}

async function createPluginFixture(): Promise<{ dir: string; configPath: string }> {
  const fixture = await createFixture(renderScopedSchema())
  // A stub introspector: the commands must fail on the flag before reaching it.
  await writeFile(
    fixture.configPath,
    `import { codegen } from ${JSON.stringify(CODEGEN_PLUGIN_ENTRY)}
import { pull } from ${JSON.stringify(PULL_PLUGIN_ENTRY)}
export default {
  schema: ${JSON.stringify(fixture.schemaPath)},
  outDir: ${JSON.stringify(join(fixture.dir, 'chkit'))},
  // Never contacted: every command here fails before it connects.
  clickhouse: { url: 'http://127.0.0.1:9', username: 'default', password: '', database: 'default' },
  plugins: [
    codegen({ outFile: ${JSON.stringify(join(fixture.dir, 'gen/types.ts'))} }),
    pull({ outFile: ${JSON.stringify(join(fixture.dir, 'pulled.ts'))}, introspect: async () => [] }),
  ],
}
`,
  )
  return fixture
}

async function createArchiveFixture(): Promise<{ dir: string; configPath: string }> {
  const fixture = await createFixture(renderScopedSchema())
  // backup declares --table, so it gets the scope; restore does not, so it rejects it.
  const pluginPath = join(fixture.dir, 'archive-plugin.ts')
  await writeFile(
    pluginPath,
    `import { definePlugin } from ${JSON.stringify(CLI_SOURCE_ENTRY)}
export const plugin = definePlugin({
  manifest: { name: 'archive', apiVersion: 1 },
  commands: [
    {
      name: 'backup',
      flags: [{ name: '--table', short: '-t', type: 'string', description: 'Tables to back up' }],
      run({ tableScope }) { console.log('backup ' + tableScope.selector + ' ' + tableScope.matchedTables.join(',')) },
    },
    { name: 'restore', run() { console.log('restore') } },
  ],
})
`,
  )
  await writeFile(
    fixture.configPath,
    `import { plugin } from ${JSON.stringify(pluginPath)}
export default { schema: ${JSON.stringify(fixture.schemaPath)}, outDir: ${JSON.stringify(join(fixture.dir, 'chkit'))}, plugins: [{ plugin }] }
`,
  )
  return fixture
}

describe('@chkit/cli --table only where it scopes the command (#565)', () => {
  test('status, codegen, pull and chkit plugin reject --table and -t as unknown flags', async () => {
    const fixture = await createPluginFixture()
    try {
      for (const command of [
        ['status'],
        ['codegen'],
        ['pull', '--dryrun'],
        ['plugin', 'codegen', 'codegen'],
        ['plugin', 'pull', 'schema', '--dryrun'],
      ]) {
        for (const [flagArgs, flag] of [
          [['--table', 'app.users'], '--table'],
          [['--table=app.users'], '--table'],
          [['-t', 'app.users'], '-t'],
        ] as const) {
          const args = [...command, '--config', fixture.configPath, ...flagArgs]
          const result = runCli(args, fixture.dir)
          expect([args, result.exitCode, result.stderr.trim(), result.stdout]).toEqual([
            args,
            1,
            `Unknown flag: ${flag}`,
            '',
          ])
        }
      }
      expect(await Bun.file(join(fixture.dir, 'gen/types.ts')).exists()).toBe(false)
      expect(await Bun.file(join(fixture.dir, 'pulled.ts')).exists()).toBe(false)

      // A leading --table moves behind the command and is rejected there too.
      const leading = runCli(['--table', 'app.users', 'status', '--config', fixture.configPath], fixture.dir)
      expect([leading.exitCode, leading.stderr.trim()]).toEqual([1, 'Unknown flag: --table'])

      const json = runCli(['status', '--config', fixture.configPath, '--table', 'app.users', '--json'], fixture.dir)
      expect(json.exitCode).toBe(1)
      expect(JSON.parse(json.stdout)).toMatchObject({
        ok: false,
        command: 'status',
        error: { code: 'usage', message: 'Unknown flag: --table' },
      })
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a plugin command that declares --table gets it wherever it is written', async () => {
    const fixture = await createArchiveFixture()
    try {
      const config = ['--config', fixture.configPath]
      for (const args of [
        ['archive', 'backup', '--table', 'app.users', ...config],
        ['archive', '--table', 'app.users', 'backup', ...config],
        ['--table', 'app.users', 'archive', 'backup', ...config],
        ['plugin', 'archive', 'backup', '-t', 'app.users', ...config],
        ['plugin', '--table', 'app.users', 'archive', 'backup', ...config],
        ['plugin', '-t=app.users', 'archive', 'backup', ...config],
        ['--table', 'app.users', 'plugin', 'archive', 'backup', ...config],
      ]) {
        const result = runCli(args, fixture.dir)
        expect([args, result.exitCode, result.stdout.trim(), result.stderr]).toEqual([args, 0, 'backup app.users app.users', ''])
      }

      // A selector that names another subcommand is still the selector.
      const named = runCli(['archive', '--table', 'restore', 'backup', ...config], fixture.dir)
      expect([named.exitCode, named.stdout.trim()]).toEqual([0, 'backup restore'])

      // A leading --table without a value does not take the next flag as its value.
      const missing = runCli(['plugin', '--table', '--json', 'archive', 'backup', ...config], fixture.dir)
      expect(missing.exitCode).toBe(1)
      expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: 'Missing value for --table' })

      for (const args of [
        ['archive', '--table', 'app.users', 'restore', ...config],
        ['plugin', '--table', 'app.users', 'archive', 'restore', ...config],
      ]) {
        const result = runCli(args, fixture.dir)
        expect([args, result.exitCode, result.stderr.trim(), result.stdout]).toEqual([args, 1, 'Unknown flag: --table', ''])
      }
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a plugin command resolves its --table selector against the schema (#626)', async () => {
    const fixture = await createArchiveFixture()
    try {
      const config = ['--config', fixture.configPath]
      for (const command of [['archive', 'backup'], ['plugin', 'archive', 'backup']]) {
        for (const [selector, expected] of [
          ['app.e*', 'backup app.e* app.events'],
          ['u*', 'backup u* app.users'],
          ['missing', 'backup missing'],
        ] as const) {
          const result = runCli([...command, '--table', selector, ...config], fixture.dir)
          expect([command, result.exitCode, result.stdout.trim(), result.stderr]).toEqual([command, 0, expected, ''])
        }

        const message = 'Invalid --table selector "a*b". "*" is only allowed as a trailing suffix (for example, events_*).'
        const invalid = runCli([...command, '--table', 'a*b', ...config], fixture.dir)
        expect([command, invalid.exitCode, invalid.stdout, invalid.stderr.trim()]).toEqual([command, 1, '', message])

        const invalidJson = runCli([...command, '--table', 'a*b', '--json', ...config], fixture.dir)
        expect(invalidJson.exitCode).toBe(1)
        expect(JSON.parse(invalidJson.stdout)).toEqual({
          command: command[0],
          schemaVersion: 1,
          ok: false,
          error: { code: 'error', message },
        })
      }
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('query does not read --table as a flag', async () => {
    const fixture = await createPluginFixture()
    try {
      // query rejects an unknown flag instead of reading it as SQL (#584).
      const result = runCli(['query', '--config', fixture.configPath, '--table', 'app.users', 'SELECT 1'], fixture.dir)
      expect([result.exitCode, result.stderr.trim()]).toEqual([1, 'Unknown flag: --table'])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('help lists --table only for the commands that take it', () => {
    const globalHelp = runCli(['-h'])
    expect(globalHelp.exitCode).toBe(0)
    expect(globalHelp.stdout).not.toContain('--table')

    for (const command of ['status', 'query']) {
      const help = runCli([command, '-h'])
      expect([command, help.exitCode, help.stdout.includes('--table')]).toEqual([command, 0, false])
    }
    for (const command of ['generate', 'migrate', 'check', 'drift']) {
      const help = runCli([command, '-h'])
      expect([command, help.exitCode]).toEqual([command, 0])
      expect(help.stdout).toContain('-t, --table <selector>')
    }
  }, 30_000)
})
