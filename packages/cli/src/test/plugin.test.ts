import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createClickHouseExecutor } from '@chkit/clickhouse'

import { getLiveEnv } from './e2e-testkit.js'
import {
  BACKFILL_PLUGIN_ENTRY,
  CLI_ENTRY,
  CORE_ENTRY,
  PULL_PLUGIN_ENTRY,
  CODEGEN_PLUGIN_ENTRY,
  createFixture,
  runCli,
} from './testkit.test'

function getClickHouseEnv(): {
  url: string
  username: string
  password: string
  database: string
} {
  const env = getLiveEnv()
  return {
    url: env.clickhouseUrl,
    username: env.clickhouseUser,
    password: env.clickhousePassword,
    database: env.clickhouseDatabase,
  }
}

function clickhouseConfigBlock(env: { url: string; username: string; password: string; database: string }): string {
  return `clickhouse: {\n    url: '${env.url}',\n    username: '${env.username}',\n    password: '${env.password}',\n    database: '${env.database}',\n  },`
}

async function createHookProbeFixture() {
  const fixture = await createFixture()
  const probePath = join(fixture.dir, 'probe-plugin.ts')
  await writeFile(
    probePath,
    `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'probe', apiVersion: 1 },\n  commands: [\n    { name: 'greet', flags: [{ name: '--name', type: 'string', description: 'Name' }], run() {} },\n    { name: 'other', run() {} },\n  ],\n  hooks: {\n    onInit({ command, flags }) {\n      console.error('onInit ' + command + ' ' + flags['--name'])\n    },\n    getContext({ command, flags }) {\n      console.error('getContext ' + command + ' ' + flags['--name'])\n      return undefined\n    },\n    onComplete({ command }) {\n      console.error('onComplete ' + command)\n    },\n  },\n})\n`,
    'utf8'
  )
  await writeFile(
    fixture.configPath,
    `import { plugin } from '${probePath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
    'utf8'
  )
  return fixture
}

async function waitForParts(
  db: ReturnType<typeof createClickHouseExecutor>,
  database: string,
  table: string,
  expectedPartitions: number,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      // Sync replica state for the target table first, then check system.parts
      await db.query(`SELECT 1 FROM ${database}.${table} LIMIT 1 SETTINGS select_sequential_consistency = 1`)
    } catch {
      // Table may not be visible yet on managed ClickHouse (DDL propagation)
      await new Promise((r) => setTimeout(r, 500))
      continue
    }
    const rows = await db.query<{ cnt: string }>(
      `SELECT count(DISTINCT partition) AS cnt FROM system.parts WHERE database = '${database}' AND table = '${table}' AND active SETTINGS select_sequential_consistency = 1`
    )
    const count = Number(rows[0]?.cnt ?? 0)
    if (count >= expectedPartitions) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for ${expectedPartitions} partitions in ${database}.${table}`)
}

describe('plugin runtime', () => {
  test('generate --dryrun --json applies onPlanCreated hook output', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'plan-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'plan-augment', apiVersion: 1 },\n  hooks: {\n    onPlanCreated({ plan }) {\n      return {\n        ...plan,\n        operations: [\n          ...plan.operations,\n          {\n            type: 'create_database',\n            key: 'database:plugin_db',\n            risk: 'safe',\n            sql: 'CREATE DATABASE IF NOT EXISTS plugin_db;',\n          },\n        ],\n        riskSummary: {\n          safe: plan.riskSummary.safe + 1,\n          caution: plan.riskSummary.caution,\n          danger: plan.riskSummary.danger,\n        },\n      }\n    },\n  },\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        operations: Array<{ key: string; type: string }>
      }
      expect(payload.operations.some((operation) => operation.key === 'database:plugin_db')).toBe(true)
      expect(payload.operations.some((operation) => operation.type === 'create_database')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('plugin command namespace executes configured plugin command', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'commands-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'echoer', apiVersion: 1 },\n  commands: [\n    {\n      name: 'echo',\n      description: 'Echo args for tests',\n      run({ args, jsonMode, print }) {\n        if (jsonMode) {\n          print({ ok: true, args })\n          return\n        }\n        print(args.join(','))\n      },\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
        'utf8'
      )

      const result = runCli([
        'plugin',
        'echoer',
        'echo',
        'alpha',
        'beta',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { ok: boolean; args: string[] }
      expect(payload.ok).toBe(true)
      expect(payload.args).toEqual(['alpha', 'beta'])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('plugin commands get only positionals in args, and -- ends their flags (#568)', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'echo-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'echoer', apiVersion: 1 },\n  commands: [\n    {\n      name: 'echo',\n      flags: [\n        { name: '--name', type: 'string', description: 'Name' },\n        { name: '--loud', type: 'boolean', description: 'Loud' },\n      ],\n      run({ args, flags, print }) {\n        print({ args, name: flags['--name'] ?? null, loud: flags['--loud'] ?? null })\n      },\n    },\n    { name: 'other', run() {} },\n  ],\n})\n`,
        'utf8'
      )
      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
        'utf8'
      )
      // The global flags go first: after --, they would be positionals.
      const run = ([command = '', ...rest]: string[]) => {
        const result = runCli([command, '--config', fixture.configPath, '--json', ...rest])
        expect(result.stderr).toBe('')
        expect(result.exitCode).toBe(0)
        return JSON.parse(result.stdout) as { args: string[]; name: string | null; loud: boolean | null }
      }

      expect(run(['plugin', 'echoer', 'echo', 'alpha', '--name', 'ada', 'beta', '--loud'])).toEqual({
        args: ['alpha', 'beta'],
        name: 'ada',
        loud: true,
      })
      // After --, every token is a positional, global flags included.
      expect(run(['plugin', 'echoer', 'echo', 'alpha', '--loud', '--', '--name', 'x', '-z', '--json', '--'])).toEqual({
        args: ['alpha', '--name', 'x', '-z', '--json', '--'],
        name: null,
        loud: true,
      })
      // After --, help and the JSON flag are arguments too.
      expect(run(['plugin', 'echoer', 'echo', '--', '--help', '-h', '--help-plugins']).args).toEqual([
        '--help',
        '-h',
        '--help-plugins',
      ])
      // A -- before the names ends the flags; the names still come first.
      expect(run(['plugin', '--', 'echoer', 'echo', '--loud']).args).toEqual(['--loud'])
      expect(run(['plugin', 'echoer', '--', 'echo', '-z']).args).toEqual(['-z'])
      // The shortcut path passes the subcommand name too, as before.
      expect(run(['echoer', 'echo', 'alpha', '--name', 'ada', '--', '--loud', '-z'])).toEqual({
        args: ['echo', 'alpha', '--loud', '-z'],
        name: 'ada',
        loud: null,
      })

      // A flag value is never the --.
      const missing = runCli(['plugin', '--config', fixture.configPath, 'echoer', 'echo', '--name', '--', 'beta'])
      expect(missing.exitCode).toBe(1)
      expect(missing.stderr.trim()).toBe('Missing value for --name')

      // A command without flags still rejects an unknown flag before --.
      const unknown = runCli(['plugin', '--config', fixture.configPath, 'echoer', 'other', '-z', '--', 'x'])
      expect(unknown.exitCode).toBe(1)
      expect(unknown.stderr.trim()).toBe('Unknown flag: -z')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('onBeforePluginCommand intercepts another plugin command', async () => {
    const fixture = await createFixture()
    const targetPath = join(fixture.dir, 'target-plugin.ts')
    const interceptorPath = join(fixture.dir, 'interceptor-plugin.ts')
    try {
      await writeFile(
        targetPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'target', apiVersion: 1 },\n  commands: [\n    {\n      name: 'greet',\n      description: 'Original greet',\n      run({ print }) {\n        print({ source: 'original' })\n        return 0\n      },\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        interceptorPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'interceptor', apiVersion: 1 },\n  hooks: {\n    onBeforePluginCommand(context) {\n      if (context.targetPlugin === 'target' && context.command === 'greet') {\n        context.print({ source: 'intercepted', target: context.targetPlugin })\n        return { handled: true, exitCode: 0 }\n      }\n      return { handled: false }\n    },\n  },\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin as target } from '${targetPath}'\nimport { plugin as interceptor } from '${interceptorPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [\n    { plugin: target },\n    { plugin: interceptor },\n  ],\n}\n`,
        'utf8'
      )

      const result = runCli([
        'plugin',
        'target',
        'greet',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { source: string; target: string }
      expect(payload.source).toBe('intercepted')
      expect(payload.target).toBe('target')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('onBeforePluginCommand returning handled: false falls through to original', async () => {
    const fixture = await createFixture()
    const targetPath = join(fixture.dir, 'target-plugin.ts')
    const interceptorPath = join(fixture.dir, 'interceptor-plugin.ts')
    try {
      await writeFile(
        targetPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'target', apiVersion: 1 },\n  commands: [\n    {\n      name: 'greet',\n      description: 'Original greet',\n      run({ print }) {\n        print({ source: 'original' })\n        return 0\n      },\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        interceptorPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'interceptor', apiVersion: 1 },\n  hooks: {\n    onBeforePluginCommand() {\n      return { handled: false }\n    },\n  },\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin as target } from '${targetPath}'\nimport { plugin as interceptor } from '${interceptorPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [\n    { plugin: target },\n    { plugin: interceptor },\n  ],\n}\n`,
        'utf8'
      )

      const result = runCli([
        'plugin',
        'target',
        'greet',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { source: string }
      expect(payload.source).toBe('original')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('plugin namespace accepts flags another plugin extends onto the target plugin', async () => {
    const fixture = await createFixture()
    const targetPath = join(fixture.dir, 'target-plugin.ts')
    const extenderPath = join(fixture.dir, 'extender-plugin.ts')
    try {
      await writeFile(
        targetPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'target', apiVersion: 1 },\n  commands: [\n    {\n      name: 'greet',\n      description: 'Original greet',\n      flags: [{ name: '--name', type: 'string', description: 'Who to greet' }],\n      run({ flags, print }) {\n        print({ flags })\n        return 0\n      },\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        extenderPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'extender', apiVersion: 1 },\n  extendCommands: [\n    { command: ['target'], flags: [{ name: '--job-id', type: 'string', description: 'Remote job ID' }] },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin as target } from '${targetPath}'\nimport { plugin as extender } from '${extenderPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [\n    { plugin: target },\n    { plugin: extender },\n  ],\n}\n`,
        'utf8'
      )

      const result = runCli([
        'plugin',
        'target',
        'greet',
        '--job-id',
        'job-123',
        '--name',
        'ada',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { flags: Record<string, unknown> }
      expect(payload.flags['--job-id']).toBe('job-123')
      expect(payload.flags['--name']).toBe('ada')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('plugin pull schema command writes pulled schema artifact', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'pull-plugin.ts')
    const outFile = join(fixture.dir, 'pulled-schema.ts')

    try {
      await writeFile(
        pluginPath,
        `import { pull } from '${PULL_PLUGIN_ENTRY}'\n\nexport const registration = pull({\n  outFile: '${outFile}',\n  databases: ['app'],\n  introspect: async () => [\n    {\n      database: 'app',\n      name: 'users',\n      engine: 'MergeTree()',\n      primaryKey: '(id)',\n      orderBy: '(id)',\n      columns: [\n        { name: 'id', type: 'UInt64' },\n        { name: 'email', type: 'String' },\n      ],\n      settings: {},\n      indexes: [],\n      projections: [],\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { registration } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  clickhouse: {\n    url: 'http://localhost:8123',\n    username: 'default',\n    password: '',\n    database: 'default',\n  },\n  plugins: [registration],\n}\n`,
        'utf8'
      )

      const result = runCli([
        'plugin',
        'pull',
        'schema',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        command: string
        outFile: string
        tableCount: number
      }
      expect(payload.ok).toBe(true)
      expect(payload.command).toBe('schema')
      expect(payload.outFile).toBe(outFile)
      expect(payload.tableCount).toBe(1)
      expect(existsSync(outFile)).toBe(true)
      const content = await readFile(outFile, 'utf8')
      expect(content).toContain('const app_users = table({')
      expect(content).toContain('export default schema(app_users)')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('pull root command runs pull plugin schema command', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'pull-plugin.ts')
    const outFile = join(fixture.dir, 'pulled-schema-root.ts')

    try {
      await writeFile(
        pluginPath,
        `import { pull } from '${PULL_PLUGIN_ENTRY}'\n\nexport const registration = pull({\n  outFile: '${outFile}',\n  databases: ['app'],\n  introspect: async () => [\n    {\n      database: 'app',\n      name: 'events',\n      engine: 'MergeTree()',\n      primaryKey: '(id)',\n      orderBy: '(id)',\n      columns: [\n        { name: 'id', type: 'UInt64' },\n      ],\n      settings: {},\n      indexes: [],\n      projections: [],\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { registration } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  clickhouse: {\n    url: 'http://localhost:8123',\n    username: 'default',\n    password: '',\n    database: 'default',\n  },\n  plugins: [registration],\n}\n`,
        'utf8'
      )

      const result = runCli(['pull', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { ok: boolean; command: string; tableCount: number }
      expect(payload.ok).toBe(true)
      expect(payload.command).toBe('schema')
      expect(payload.tableCount).toBe(1)
      expect(existsSync(outFile)).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('pull root command passes the same flags to onInit and getContext', async () => {
    const fixture = await createFixture()
    const pullPath = join(fixture.dir, 'pull-plugin.ts')
    const probePath = join(fixture.dir, 'probe-plugin.ts')

    try {
      await writeFile(
        pullPath,
        `import { pull } from '${PULL_PLUGIN_ENTRY}'\n\nexport const registration = pull({\n  outFile: '${join(fixture.dir, 'pulled.ts')}',\n  databases: ['app'],\n  introspect: async () => [],\n})\n`,
        'utf8'
      )

      await writeFile(
        probePath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const plugin = definePlugin({\n  manifest: { name: 'probe', apiVersion: 1 },\n  extendCommands: [{ command: 'pull', flags: [{ name: '--service', type: 'string', description: 'Service' }] }],\n  hooks: {\n    onInit({ flags }) {\n      console.error('onInit ' + flags['--service'])\n    },\n    getContext({ flags }) {\n      console.error('getContext ' + flags['--service'])\n      return undefined\n    },\n  },\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { registration } from '${pullPath}'\nimport { plugin as probe } from '${probePath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  clickhouse: {\n    url: 'http://localhost:8123',\n    username: 'default',\n    password: '',\n    database: 'default',\n  },\n  plugins: [registration, { plugin: probe }],\n}\n`,
        'utf8'
      )

      const result = runCli([
        'pull',
        '--dryrun',
        '--service',
        'svc-b',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stderr.trim().split('\n')).toEqual(['onInit svc-b', 'getContext svc-b'])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('plugin subcommand passes its parsed flags to onInit', async () => {
    const fixture = await createHookProbeFixture()
    try {
      const result = runCli(['probe', 'greet', '--name', 'ada', '--config', fixture.configPath])
      expect(result.exitCode).toBe(0)
      expect(result.stderr.trim().split('\n')).toEqual([
        'onInit probe ada',
        'getContext greet ada',
        'onComplete probe',
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit plugin passes the target command flags to onInit', async () => {
    const fixture = await createHookProbeFixture()
    try {
      const result = runCli(['plugin', 'probe', 'greet', '--name', 'ada', '--config', fixture.configPath])
      expect(result.exitCode).toBe(0)
      const lines = result.stderr.trim().split('\n')
      expect(lines[0]).toBe('onInit plugin ada')
      expect(lines).toContain('getContext greet ada')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('plugin subcommand flag error prints one error and skips onInit and onComplete', async () => {
    const fixture = await createHookProbeFixture()
    try {
      const result = runCli(['probe', 'greet', '--bogus', '--config', fixture.configPath])
      expect(result.exitCode).toBe(1)
      expect(result.stderr.trim()).toBe('Unknown flag: --bogus')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit plugin flag error is reported before onInit, getContext and onComplete, like the shortcut', async () => {
    const fixture = await createHookProbeFixture()
    try {
      const cases: Array<[string[], string]> = [
        [['greet', '--bogus'], 'Unknown flag: --bogus'],
        [['greet', '--name'], 'Missing value for --name'],
        [['other', '-x'], 'Unknown flag: -x'],
      ]
      for (const [args, message] of cases) {
        const shortcut = runCli(['probe', ...args, '--config', fixture.configPath])
        const forwarded = runCli(['plugin', 'probe', ...args, '--config', fixture.configPath])
        expect([shortcut.exitCode, shortcut.stderr.trim()]).toEqual([1, message])
        expect([forwarded.exitCode, forwarded.stdout, forwarded.stderr.trim()]).toEqual([1, '', message])
      }

      const json = runCli(['plugin', 'probe', 'greet', '--bogus', '--json', '--config', fixture.configPath])
      expect(json.exitCode).toBe(1)
      expect(json.stderr).toBe('')
      expect(JSON.parse(json.stdout)).toEqual({
        command: 'plugin',
        schemaVersion: 1,
        ok: false,
        error: 'Unknown flag: --bogus',
      })
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('a plugin command without flags rejects an unknown short flag in both forms (#491)', async () => {
    const fixture = await createHookProbeFixture()
    try {
      const shortcut = runCli(['probe', 'other', '-x', '--config', fixture.configPath])
      expect(shortcut.exitCode).toBe(1)
      expect(shortcut.stderr.trim()).toBe('Unknown flag: -x')

      const forwarded = runCli(['plugin', 'probe', 'other', '-x', '--config', fixture.configPath])
      expect(forwarded.exitCode).toBe(1)
      expect(forwarded.stderr).toContain('Unknown flag: -x')
      expect(forwarded.stderr).not.toContain('getContext other')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit plugin backfill plan writes state artifact', async () => {
    const chEnv = getClickHouseEnv()
    const chConfig = clickhouseConfigBlock(chEnv)
    const tableName = `chkit_e2e_bf_plan_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const db = createClickHouseExecutor(chEnv)
    try {
      await db.command(`CREATE TABLE ${chEnv.database}.${tableName} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (1, '2026-01-01 12:00:00'), (2, '2026-01-02 12:00:00')`)
      await waitForParts(db, chEnv.database, tableName, 2)

      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
      try {
        await writeFile(
          pluginPath,
          `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin()\n`,
          'utf8'
        )

        await writeFile(
          fixture.configPath,
          `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  ${chConfig}\n  plugins: [{ plugin }],\n}\n`,
          'utf8'
        )

        const result = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2026-01-03T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(result.exitCode).toBe(0)
        const payload = JSON.parse(result.stdout) as {
          ok: boolean
          planId: string
          chunkCount: number
          planPath: string
        }
        expect(payload.ok).toBe(true)
        expect(payload.planId).toMatch(/^[a-f0-9]{16}$/)
        expect(payload.chunkCount).toBeGreaterThanOrEqual(1)
        expect(existsSync(payload.planPath)).toBe(true)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    } finally {
      await db.command(`DROP TABLE IF EXISTS ${chEnv.database}.${tableName}`)
      await db.close()
    }
  }, 120_000)

  test('chkit plugin backfill run and status complete planned chunks', async () => {
    const chEnv = getClickHouseEnv()
    const chConfig = clickhouseConfigBlock(chEnv)
    const tableName = `chkit_e2e_bf_run_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const db = createClickHouseExecutor(chEnv)
    try {
      await db.command(`CREATE TABLE ${chEnv.database}.${tableName} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (1, '2026-01-01 12:00:00'), (2, '2026-01-02 12:00:00')`)
      await waitForParts(db, chEnv.database, tableName, 2)

      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
      try {
        await writeFile(
          pluginPath,
          `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin()\n`,
          'utf8'
        )

        await writeFile(
          fixture.configPath,
          `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  ${chConfig}\n  plugins: [{ plugin }],\n}\n`,
          'utf8'
        )

        const planned = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2026-01-03T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(planned.exitCode).toBe(0)
        const planPayload = JSON.parse(planned.stdout) as { planId: string }

        const ran = runCli([
          'plugin',
          'backfill',
          'run',
          '--plan-id',
          planPayload.planId,
          '--poll-interval',
          '1000',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(ran.exitCode).toBe(0)
        const runPayload = JSON.parse(ran.stdout) as {
          status: string
          chunkCounts: { done: number; total: number; failed: number }
        }
        expect(runPayload.status).toBe('completed')
        expect(runPayload.chunkCounts.total).toBeGreaterThanOrEqual(1)
        expect(runPayload.chunkCounts.done).toBe(runPayload.chunkCounts.total)
        expect(runPayload.chunkCounts.failed).toBe(0)

        const status = runCli([
          'plugin',
          'backfill',
          'status',
          '--plan-id',
          planPayload.planId,
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(status.exitCode).toBe(0)
        const statusPayload = JSON.parse(status.stdout) as {
          status: string
          chunkCounts: { done: number; total: number; failed: number }
        }
        expect(statusPayload.status).toBe('completed')
        expect(statusPayload.chunkCounts.done).toBe(statusPayload.chunkCounts.total)
        expect(statusPayload.chunkCounts.failed).toBe(0)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    } finally {
      await db.command(`DROP TABLE IF EXISTS ${chEnv.database}.${tableName}`)
      await db.close()
    }
  }, 120_000)

  test('chkit plugin backfill resume on completed run is a no-op', async () => {
    const chEnv = getClickHouseEnv()
    const chConfig = clickhouseConfigBlock(chEnv)
    const tableName = `chkit_e2e_bf_resume_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const db = createClickHouseExecutor(chEnv)
    try {
      await db.command(`CREATE TABLE ${chEnv.database}.${tableName} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (1, '2026-01-01 12:00:00'), (2, '2026-01-02 12:00:00')`)
      await waitForParts(db, chEnv.database, tableName, 2)

      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
      try {
        await writeFile(
          pluginPath,
          `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin()\n`,
          'utf8'
        )

        await writeFile(
          fixture.configPath,
          `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  ${chConfig}\n  plugins: [{ plugin }],\n}\n`,
          'utf8'
        )

        const planned = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2026-01-03T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(planned.exitCode).toBe(0)
        const planPayload = JSON.parse(planned.stdout) as { planId: string }

        const ran = runCli([
          'plugin',
          'backfill',
          'run',
          '--plan-id',
          planPayload.planId,
          '--poll-interval',
          '1000',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(ran.exitCode).toBe(0)
        const ranPayload = JSON.parse(ran.stdout) as { status: string }
        expect(ranPayload.status).toBe('completed')

        const resumed = runCli([
          'plugin',
          'backfill',
          'resume',
          '--plan-id',
          planPayload.planId,
          '--poll-interval',
          '1000',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(resumed.exitCode).toBe(0)
        const resumedPayload = JSON.parse(resumed.stdout) as { noop?: boolean }
        expect(resumedPayload.noop).toBe(true)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    } finally {
      await db.command(`DROP TABLE IF EXISTS ${chEnv.database}.${tableName}`)
      await db.close()
    }
  }, 120_000)

  test('chkit check --json requires clickhouse config', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
        'utf8'
      )

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for check')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit check --json requires clickhouse config even with completed backfill', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin({ chunkHours: 2 })\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
        'utf8'
      )

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for check')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit plugin backfill resume requires existing run state', async () => {
    const chEnv = getClickHouseEnv()
    const chConfig = clickhouseConfigBlock(chEnv)
    const tableName = `chkit_e2e_bf_compat_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const db = createClickHouseExecutor(chEnv)
    try {
      await db.command(`CREATE TABLE ${chEnv.database}.${tableName} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (1, '2026-01-01 12:00:00'), (2, '2026-01-02 12:00:00')`)
      await waitForParts(db, chEnv.database, tableName, 2)

      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
      try {
        await writeFile(
          pluginPath,
          `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin()\n`,
          'utf8'
        )
        await writeFile(
          fixture.configPath,
          `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  ${chConfig}\n  plugins: [{ plugin }],\n}\n`,
          'utf8'
        )

        const planned = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2026-01-03T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(planned.exitCode).toBe(0)
        const planPayload = JSON.parse(planned.stdout) as { planId: string }

        const blockedResume = runCli([
          'plugin',
          'backfill',
          'resume',
          '--plan-id',
          planPayload.planId,
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(blockedResume.exitCode).toBe(2)
        expect(blockedResume.stdout).toContain('Run state not found')
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    } finally {
      await db.command(`DROP TABLE IF EXISTS ${chEnv.database}.${tableName}`)
      await db.close()
    }
  }, 120_000)

  test('chkit plugin backfill cancel and doctor provide operator remediation flow', async () => {
    const chEnv = getClickHouseEnv()
    const chConfig = clickhouseConfigBlock(chEnv)
    const tableName = `chkit_e2e_bf_doctor_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const db = createClickHouseExecutor(chEnv)
    try {
      await db.command(`CREATE TABLE ${chEnv.database}.${tableName} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (1, '2026-01-01 12:00:00'), (2, '2026-01-02 12:00:00')`)
      await waitForParts(db, chEnv.database, tableName, 2)

      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
      try {
        await writeFile(
          pluginPath,
          `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin()\n`,
          'utf8'
        )
        await writeFile(
          fixture.configPath,
          `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  ${chConfig}\n  plugins: [{ plugin }],\n}\n`,
          'utf8'
        )

        const planned = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2026-01-03T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        const planPayload = JSON.parse(planned.stdout) as { planId: string }

        runCli([
          'plugin',
          'backfill',
          'run',
          '--plan-id',
          planPayload.planId,
          '--poll-interval',
          '1000',
          '--config',
          fixture.configPath,
          '--json',
        ])

        // Doctor on completed run should report no issues
        const doctorOk = runCli([
          'plugin',
          'backfill',
          'doctor',
          '--plan-id',
          planPayload.planId,
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(doctorOk.exitCode).toBe(0)

        // Cancel on completed run should fail
        const cancelCompleted = runCli([
          'plugin',
          'backfill',
          'cancel',
          '--plan-id',
          planPayload.planId,
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(cancelCompleted.exitCode).toBe(2)
        expect(cancelCompleted.stdout).toContain('already completed')

        // Insert data for the second plan's time range
        await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (4, '2026-01-05 12:00:00'), (5, '2026-01-06 12:00:00')`)
        await waitForParts(db, chEnv.database, tableName, 4)

        // Plan a second backfill that we won't run — doctor should flag it
        const planned2 = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-04T00:00:00.000Z',
          '--to',
          '2026-01-07T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        const plan2Payload = JSON.parse(planned2.stdout) as { planId: string }

        const doctor2 = runCli([
          'plugin',
          'backfill',
          'doctor',
          '--plan-id',
          plan2Payload.planId,
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(doctor2.exitCode).toBe(1)
        const doctorPayload = JSON.parse(doctor2.stdout) as {
          issueCodes: string[]
          recommendations: string[]
        }
        expect(doctorPayload.issueCodes).toContain('backfill_plan_missing')
        expect(doctorPayload.recommendations.join(' ')).toContain('backfill run')
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    } finally {
      await db.command(`DROP TABLE IF EXISTS ${chEnv.database}.${tableName}`)
      await db.close()
    }
  }, 120_000)

  test('chkit codegen writes output file', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport const plugin = createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
        'utf8'
      )

      const result = runCli(['codegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        outFile: string
        mode: string
      }
      expect(payload.ok).toBe(true)
      expect(payload.mode).toBe('write')
      expect(payload.outFile).toBe(outFile)

      const content = await readFile(outFile, 'utf8')
      expect(content).toContain('export type AppUsersRow = {')
      expect(content.endsWith('\n')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit codegen writes output file with typed inline plugin registration', async () => {
    const fixture = await createFixture()
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    try {
      await writeFile(
        fixture.configPath,
        `import { defineConfig } from '${CORE_ENTRY}'\nimport { codegen } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default defineConfig({\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [codegen({ outFile: './src/generated/chkit-types.ts' })],\n})\n`,
        'utf8'
      )

      const result = runCli(['codegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        outFile: string
        mode: string
      }
      expect(payload.ok).toBe(true)
      expect(payload.mode).toBe('write')
      expect(payload.outFile).toBe(outFile)
      expect(existsSync(outFile)).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit codegen writes executable compressed ingest helpers', async () => {
    const fixture = await createFixture()
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    const ingestOutFile = join(fixture.dir, 'src/generated/chkit-ingest.ts')
    try {
      await writeFile(
        fixture.configPath,
        `import { defineConfig } from '${CORE_ENTRY}'\nimport { codegen } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default defineConfig({\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [codegen({ outFile: './src/generated/chkit-types.ts', emitIngest: true, ingestOutFile: './src/generated/chkit-ingest.ts' })],\n})\n`,
        'utf8'
      )

      const result = runCli(['codegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      expect(existsSync(outFile)).toBe(true)
      expect(existsSync(ingestOutFile)).toBe(true)

      const generated = await import(pathToFileURL(ingestOutFile).href)
      const insertCalls: Array<{
        table: string
        values: Array<Record<string, unknown>>
        compressed?: boolean
      }> = []
      const ingestor = {
        async insert(params: {
          table: string
          values: Array<Record<string, unknown>>
          compressed?: boolean
        }) {
          insertCalls.push(params)
        },
      }
      const rows = [{ id: '1', email: 'ada@example.com' }]

      await generated.ingestAppUsers(ingestor, rows)
      await generated.ingestAppUsers(ingestor, rows, { compressed: false })

      expect(insertCalls).toEqual([
        { table: 'app.users', values: rows, compressed: true },
        { table: 'app.users', values: rows, compressed: false },
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit generate runs codegen plugin when runOnGenerate is enabled', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport const plugin = createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(result.exitCode).toBe(0)
      expect(existsSync(outFile)).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit generate skips codegen plugin when runOnGenerate is false', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport const plugin = createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin, options: { runOnGenerate: false } }],\n}\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(result.exitCode).toBe(0)
      expect(existsSync(outFile)).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit codegen --check passes when output is up-to-date', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport const plugin = createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
        'utf8'
      )

      runCli(['codegen', '--config', fixture.configPath, '--json'])
      const result = runCli(['codegen', '--check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { ok: boolean; mode: string; findingCodes: string[] }
      expect(payload.ok).toBe(true)
      expect(payload.mode).toBe('check')
      expect(payload.findingCodes).toEqual([])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit codegen --check fails on drifted output', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport const plugin = createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
        'utf8'
      )

      runCli(['codegen', '--config', fixture.configPath, '--json'])
      await writeFile(outFile, '// drifted\n', 'utf8')
      const result = runCli(['codegen', '--check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      const payload = JSON.parse(result.stdout) as { ok: boolean; findingCodes: string[]; mode: string }
      expect(payload.ok).toBe(false)
      expect(payload.mode).toBe('check')
      expect(payload.findingCodes.length).toBe(1)
      expect(['codegen_stale_output', 'codegen_missing_output']).toContain(payload.findingCodes[0])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('codegen root command fails when codegen plugin is not configured', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['codegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Codegen plugin is not configured')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('pull root command fails when pull plugin is not configured', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['pull', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Pull plugin is not configured')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('codegen returns exit code 2 for invalid plugin options', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(
        fixture.configPath,
        `import { codegen } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [codegen({ bigintMode: 'nope' })],\n}\n`,
        'utf8'
      )

      const result = runCli(['codegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(2)
      const payload = JSON.parse(result.stdout) as { ok: boolean; error: string }
      expect(payload.ok).toBe(false)
      expect(payload.error).toContain('bigintMode:')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit check --json requires clickhouse config with codegen plugin', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport const plugin = createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `import { plugin } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ plugin }],\n}\n`,
        'utf8'
      )

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for check')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
