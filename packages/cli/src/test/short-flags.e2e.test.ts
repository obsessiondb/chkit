import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { spawnWithTimeout } from './spawn-cli.js'
import { createFixture, renderScopedSchema, WORKSPACE_ROOT } from './testkit.test'

const CLI_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/dist/bin/chkit.js')
const PULL_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-pull/src/index.ts')

function runCli(args: string[], cwd = WORKSPACE_ROOT) {
  return spawnWithTimeout(['node', CLI_ENTRY, ...args], { cwd })
}

async function createPullFixture(): Promise<{ dir: string; configPath: string }> {
  const fixture = await createFixture()
  // A stub introspector: the test covers flag parsing, not ClickHouse.
  await writeFile(
    fixture.configPath,
    `import { pull } from ${JSON.stringify(PULL_PLUGIN_ENTRY)}
export default {
  schema: [],
  clickhouse: { url: 'http://localhost:8123', username: 'default', password: '', database: 'default' },
  plugins: [pull({ introspect: async ({ databases }) => databases.map((database) => ({
    database, name: 'users', engine: 'MergeTree()', primaryKey: '(id)', orderBy: '(id)',
    columns: [{ name: 'id', type: 'UInt64' }], settings: {}, indexes: [], projections: [],
  })) })],
}
`,
  )
  return fixture
}

describe('@chkit/cli short flags (#491)', () => {
  test('-c and -t read as --config and --table in every form, before or after the command', async () => {
    const fixture = await createFixture(renderScopedSchema())
    try {
      const long = runCli(['generate', '--config', fixture.configPath, '--table', 'app.users', '--dryrun', '--json'])
      expect(long.exitCode).toBe(0)
      const expected = JSON.parse(long.stdout) as { scope: { enabled: boolean; matchedTables: string[] } }
      expect(expected.scope).toMatchObject({ enabled: true, matchedTables: ['app.users'] })

      for (const args of [
        ['generate', '-c', fixture.configPath, '-t', 'app.users', '--dryrun', '--json'],
        ['generate', `-c=${fixture.configPath}`, '-t=app.users', '--dryrun', '--json'],
        ['generate', `-c${fixture.configPath}`, '-tapp.users', '--dryrun', '--json'],
        ['-c', fixture.configPath, '-t', 'app.users', 'generate', '--dryrun', '--json'],
      ]) {
        const result = runCli(args)
        expect([args, result.exitCode, result.stderr]).toEqual([args, 0, long.stderr])
        expect(JSON.parse(result.stdout)).toEqual(expected)
      }

      const longMissing = runCli(['status', '--config', '/nonexistent.ts'])
      const shortMissing = runCli(['status', '-c', '/nonexistent.ts'])
      expect(longMissing.exitCode).toBe(1)
      expect([shortMissing.exitCode, shortMissing.stdout, shortMissing.stderr]).toEqual([
        longMissing.exitCode,
        longMissing.stdout,
        longMissing.stderr,
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate -n names the migration', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['generate', '-c', fixture.configPath, '-n', 'init', '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { migrationFile: string }
      expect(payload.migrationFile).toEndWith('_init.sql')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('pull -o, -d and -f work as --out-file, --database and --force, also through chkit plugin', async () => {
    const fixture = await createPullFixture()
    try {
      const outFile = join(fixture.dir, 'pulled.ts')
      const first = runCli(['pull', '-c', fixture.configPath, '-o', outFile, '-d', 'app,other', '--json'])
      expect(first.exitCode).toBe(0)
      expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, outFile, databases: ['app', 'other'] })

      const exists = runCli(['pull', '-c', fixture.configPath, '-o', outFile, '-d', 'app', '--json'])
      expect(exists.exitCode).toBe(2)
      expect(JSON.parse(exists.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('already exists') })

      const forced = runCli(['pull', '-c', fixture.configPath, `-o${outFile}`, '-f', '-d=app', '--json'])
      expect(forced.exitCode).toBe(0)
      expect(JSON.parse(forced.stdout)).toMatchObject({ ok: true, databases: ['app'] })

      const forwarded = runCli(['plugin', 'pull', 'schema', '-c', fixture.configPath, '-o', outFile, '-f', '-d', 'other', '--json'])
      expect(forwarded.exitCode).toBe(0)
      expect(JSON.parse(forwarded.stdout)).toMatchObject({ ok: true, databases: ['other'] })
      expect(await readFile(outFile, 'utf8')).toContain('database: "other"')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('-v and -V print the version, and help lists the short forms', () => {
    const version = runCli(['--version'])
    expect(version.exitCode).toBe(0)
    for (const flag of ['-v', '-V']) {
      expect(runCli([flag])).toMatchObject({ exitCode: 0, stdout: version.stdout })
    }

    const help = runCli(['-h'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('-c, --config <path>')
    expect(help.stdout).toContain('-v, -V, --version')

    const generateHelp = runCli(['generate', '-h'])
    expect(generateHelp.exitCode).toBe(0)
    expect(generateHelp.stdout).toContain('-n, --name <name>')
    expect(generateHelp.stdout).toContain('-t, --table <selector>')
  })

  test('init rejects unknown flags before writing anything and accepts -y', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-init-flags-'))
    try {
      // Resolvable @chkit/core, so init does not install dependencies.
      await mkdir(join(dir, 'node_modules/@chkit'), { recursive: true })
      await symlink(join(WORKSPACE_ROOT, 'packages/core'), join(dir, 'node_modules/@chkit/core'))
      await writeFile(join(dir, 'package.json'), '{"name":"init-flags","private":true,"type":"module"}\n')

      for (const [args, message] of [
        [['init', '--bogus'], 'Unknown flag: --bogus'],
        [['init', '-x'], 'Unknown flag: -x'],
        [['init', '-y', '--yes=1'], 'Unknown flag: --yes=1'],
        [['init', '--connect'], 'Missing value for --connect'],
      ] as const) {
        const result = runCli([...args], dir)
        expect([args, result.exitCode, result.stderr.trim()]).toEqual([args, 1, message])
      }
      expect(existsSync(join(dir, 'clickhouse.config.ts'))).toBe(false)

      const accepted = runCli(['init', '-y'], dir)
      expect(accepted.exitCode).toBe(0)
      expect(accepted.stdout).toContain('Next steps:')
      expect(existsSync(join(dir, 'clickhouse.config.ts'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
