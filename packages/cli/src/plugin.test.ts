import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CLI_ENTRY, createFixture, runCli } from './testkit.test'

describe('plugin runtime', () => {
  test('generate --dryrun --json applies onPlanCreated hook output', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'plan-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport default definePlugin({\n  manifest: { name: 'plan-augment', apiVersion: 1 },\n  hooks: {\n    onPlanCreated({ plan }) {\n      return {\n        ...plan,\n        operations: [\n          ...plan.operations,\n          {\n            type: 'create_database',\n            key: 'database:plugin_db',\n            risk: 'safe',\n            sql: 'CREATE DATABASE IF NOT EXISTS plugin_db;',\n          },\n        ],\n        riskSummary: {\n          safe: plan.riskSummary.safe + 1,\n          caution: plan.riskSummary.caution,\n          danger: plan.riskSummary.danger,\n        },\n      }\n    },\n  },\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './plan-plugin.ts' }],\n}\n`,
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
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport default definePlugin({\n  manifest: { name: 'echoer', apiVersion: 1 },\n  commands: [\n    {\n      name: 'echo',\n      description: 'Echo args for tests',\n      run({ args, jsonMode, print }) {\n        if (jsonMode) {\n          print({ ok: true, args })\n          return\n        }\n        print(args.join(','))\n      },\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './commands-plugin.ts' }],\n}\n`,
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
})
