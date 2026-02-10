import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  BACKFILL_PLUGIN_ENTRY,
  CLI_ENTRY,
  CORE_ENTRY,
  TYPEGEN_PLUGIN_ENTRY,
  createFixture,
  runCli,
} from './testkit.test'

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

  test('chx plugin backfill plan writes deterministic state artifact', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const first = runCli([
        'plugin',
        'backfill',
        'plan',
        '--target',
        'app.users',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to',
        '2026-01-01T12:00:00.000Z',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(first.exitCode).toBe(0)
      const firstPayload = JSON.parse(first.stdout) as {
        ok: boolean
        planId: string
        chunkCount: number
        chunkHours: number
        existed: boolean
        planPath: string
      }
      expect(firstPayload.ok).toBe(true)
      expect(firstPayload.chunkCount).toBe(2)
      expect(firstPayload.chunkHours).toBe(6)
      expect(firstPayload.existed).toBe(false)
      expect(existsSync(firstPayload.planPath)).toBe(true)

      const second = runCli([
        'plugin',
        'backfill',
        'plan',
        '--target',
        'app.users',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to',
        '2026-01-01T12:00:00.000Z',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(second.exitCode).toBe(0)
      const secondPayload = JSON.parse(second.stdout) as {
        planId: string
        existed: boolean
      }
      expect(secondPayload.planId).toBe(firstPayload.planId)
      expect(secondPayload.existed).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chx typegen writes output file', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'typegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chx-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createTypegenPlugin } from '${TYPEGEN_PLUGIN_ENTRY}'\n\nexport default createTypegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './typegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli(['typegen', '--config', fixture.configPath, '--json'])
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
      expect(content).toContain('export interface AppUsersRow')
      expect(content.endsWith('\n')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chx typegen writes output file with typed inline plugin registration', async () => {
    const fixture = await createFixture()
    const outFile = join(fixture.dir, 'src/generated/chx-types.ts')
    try {
      await writeFile(
        fixture.configPath,
        `import { defineConfig } from '${CORE_ENTRY}'\nimport { typegen } from '${TYPEGEN_PLUGIN_ENTRY}'\n\nexport default defineConfig({\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [typegen({ outFile: './src/generated/chx-types.ts' })],\n})\n`,
        'utf8'
      )

      const result = runCli(['typegen', '--config', fixture.configPath, '--json'])
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

  test('chx generate runs typegen plugin when runOnGenerate is enabled', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'typegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chx-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createTypegenPlugin } from '${TYPEGEN_PLUGIN_ENTRY}'\n\nexport default createTypegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './typegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(result.exitCode).toBe(0)
      expect(existsSync(outFile)).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chx generate skips typegen plugin when runOnGenerate is false', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'typegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chx-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createTypegenPlugin } from '${TYPEGEN_PLUGIN_ENTRY}'\n\nexport default createTypegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './typegen-plugin.ts', options: { runOnGenerate: false } }],\n}\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(result.exitCode).toBe(0)
      expect(existsSync(outFile)).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chx typegen --check passes when output is up-to-date', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'typegen-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createTypegenPlugin } from '${TYPEGEN_PLUGIN_ENTRY}'\n\nexport default createTypegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './typegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      runCli(['typegen', '--config', fixture.configPath, '--json'])
      const result = runCli(['typegen', '--check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { ok: boolean; mode: string; findingCodes: string[] }
      expect(payload.ok).toBe(true)
      expect(payload.mode).toBe('check')
      expect(payload.findingCodes).toEqual([])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chx typegen --check fails on drifted output', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'typegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chx-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createTypegenPlugin } from '${TYPEGEN_PLUGIN_ENTRY}'\n\nexport default createTypegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './typegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      runCli(['typegen', '--config', fixture.configPath, '--json'])
      await writeFile(outFile, '// drifted\n', 'utf8')
      const result = runCli(['typegen', '--check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      const payload = JSON.parse(result.stdout) as { ok: boolean; findingCodes: string[]; mode: string }
      expect(payload.ok).toBe(false)
      expect(payload.mode).toBe('check')
      expect(payload.findingCodes.length).toBe(1)
      expect(['typegen_stale_output', 'typegen_missing_output']).toContain(payload.findingCodes[0])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('typegen root command fails when typegen plugin is not configured', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['typegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Typegen plugin is not configured')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('typegen returns exit code 2 for invalid plugin options', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'typegen-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createTypegenPlugin } from '${TYPEGEN_PLUGIN_ENTRY}'\n\nexport default createTypegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './typegen-plugin.ts', options: { bigintMode: 'nope' } }],\n}\n`,
        'utf8'
      )

      const result = runCli(['typegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(2)
      const payload = JSON.parse(result.stdout) as { ok: boolean; error: string }
      expect(payload.ok).toBe(false)
      expect(payload.error).toContain('Invalid plugin option "bigintMode"')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chx check --json includes typegen plugin result and fails when output is missing', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'typegen-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createTypegenPlugin } from '${TYPEGEN_PLUGIN_ENTRY}'\n\nexport default createTypegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './typegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        failedChecks: string[]
        plugins: {
          typegen?: {
            evaluated: boolean
            ok: boolean
            findingCodes: string[]
            outFile: string
          }
        }
      }
      expect(payload.ok).toBe(false)
      expect(payload.failedChecks).toContain('plugin:typegen')
      expect(payload.plugins.typegen?.evaluated).toBe(true)
      expect(payload.plugins.typegen?.ok).toBe(false)
      expect(payload.plugins.typegen?.findingCodes).toContain('typegen_missing_output')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chx check --json passes plugin:typegen when output is current', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'typegen-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createTypegenPlugin } from '${TYPEGEN_PLUGIN_ENTRY}'\n\nexport default createTypegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './typegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      runCli(['typegen', '--config', fixture.configPath, '--json'])
      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        failedChecks: string[]
        plugins: {
          typegen?: {
            evaluated: boolean
            ok: boolean
            findingCodes: string[]
          }
        }
      }
      expect(payload.ok).toBe(true)
      expect(payload.failedChecks).not.toContain('plugin:typegen')
      expect(payload.plugins.typegen?.evaluated).toBe(true)
      expect(payload.plugins.typegen?.ok).toBe(true)
      expect(payload.plugins.typegen?.findingCodes).toEqual([])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
