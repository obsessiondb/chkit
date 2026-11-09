import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { spawnWithTimeout } from './spawn-cli.js'
import { CODEGEN_PLUGIN_ENTRY, createFixture, PULL_PLUGIN_ENTRY, renderScopedSchema, WORKSPACE_ROOT } from './testkit.test'

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

  test('query does not read --table as a flag', async () => {
    const fixture = await createPluginFixture()
    try {
      // query passes unknown tokens through as SQL, so the selector makes a second argument.
      const result = runCli(['query', '--config', fixture.configPath, '--table', 'app.users', 'SELECT 1'], fixture.dir)
      expect([result.exitCode, result.stderr.trim()]).toEqual([
        1,
        'query accepts a single SQL string. Wrap it in quotes if it contains spaces.',
      ])
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
