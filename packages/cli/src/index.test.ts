import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import * as cliModule from './index'

describe('@chx/cli smoke', () => {
  test('imports package entry', () => {
    expect(typeof cliModule).toBe('object')
  })
})

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
const CORE_ENTRY = join(WORKSPACE_ROOT, 'packages/core/src/index.ts')

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ['bun', './packages/cli/src/bin/chx.ts', ...args],
    cwd: WORKSPACE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

async function createFixture(): Promise<{
  dir: string
  configPath: string
  migrationsDir: string
  metaDir: string
  schemaPath: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'chx-cli-test-'))
  const schemaPath = join(dir, 'schema.ts')
  const configPath = join(dir, 'clickhouse.config.ts')
  const outDir = join(dir, 'chx')
  const migrationsDir = join(outDir, 'migrations')
  const metaDir = join(outDir, 'meta')

  await writeFile(
    schemaPath,
    `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`,
    'utf8'
  )

  await writeFile(
    configPath,
    `export default {\n  schema: '${schemaPath}',\n  outDir: '${outDir}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${metaDir}',\n}\n`,
    'utf8'
  )

  return { dir, configPath, migrationsDir, metaDir, schemaPath }
}

describe('@chx/cli command flows', () => {
  test('generate --plan --json emits operation plan payload', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['generate', '--config', fixture.configPath, '--plan', '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        command: string
        mode: string
        operationCount: number
        operations: Array<{ type: string }>
      }
      expect(payload.command).toBe('generate')
      expect(payload.mode).toBe('plan')
      expect(payload.operationCount).toBeGreaterThan(0)
      expect(payload.operations.some((op) => op.type === 'create_table')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate --json then status --json shows pending migration', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(generated.exitCode).toBe(0)
      const generatePayload = JSON.parse(generated.stdout) as { migrationFile: string | null }
      expect(generatePayload.migrationFile).toBeTruthy()

      const status = runCli(['status', '--config', fixture.configPath, '--json'])
      expect(status.exitCode).toBe(0)
      const statusPayload = JSON.parse(status.stdout) as {
        total: number
        pending: number
        checksumMismatchCount: number
      }
      expect(statusPayload.total).toBe(1)
      expect(statusPayload.pending).toBe(1)
      expect(statusPayload.checksumMismatchCount).toBe(0)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('status fails with actionable error on corrupted journal json', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(generated.exitCode).toBe(0)
      await Bun.write(join(fixture.metaDir, 'journal.json'), '{not-valid-json')

      const status = runCli(['status', '--config', fixture.configPath, '--json'])
      expect(status.exitCode).toBe(1)
      expect(status.stderr).toContain('Invalid journal JSON')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('status --json reports checksum mismatch for applied migration drift', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(generated.exitCode).toBe(0)
      const generatePayload = JSON.parse(generated.stdout) as { migrationFile: string | null }
      expect(generatePayload.migrationFile).toBeTruthy()
      if (!generatePayload.migrationFile) {
        throw new Error('expected generated migration file')
      }

      await writeFile(
        join(fixture.metaDir, 'journal.json'),
        `${JSON.stringify(
          {
            version: 1,
            applied: [
              {
                name: '99999999999999_init.sql',
                appliedAt: new Date().toISOString(),
                checksum: 'abc123',
              },
            ],
          },
          null,
          2
        )}\n`,
        'utf8'
      )

      await writeFile(join(fixture.migrationsDir, '99999999999999_init.sql'), 'SELECT 1;\n', 'utf8')

      const status = runCli(['status', '--config', fixture.configPath, '--json'])
      expect(status.exitCode).toBe(0)
      const statusPayload = JSON.parse(status.stdout) as {
        checksumMismatchCount: number
        checksumMismatches: Array<{ name: string }>
      }
      expect(statusPayload.checksumMismatchCount).toBe(1)
      expect(statusPayload.checksumMismatches[0]?.name).toBe('99999999999999_init.sql')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate --json returns structured validation errors', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst broken = table({\n  database: 'app',\n  name: 'broken',\n  columns: [{ name: 'id', type: 'UInt64' }],\n  engine: 'MergeTree()',\n  primaryKey: ['missing_col'],\n  orderBy: ['id'],\n})\n\nexport default schema(broken)\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)

      const payload = JSON.parse(result.stdout) as {
        command: string
        error: string
        issues: Array<{ code: string; message: string }>
      }
      expect(payload.command).toBe('generate')
      expect(payload.error).toBe('validation_failed')
      expect(payload.issues.some((issue) => issue.code === 'primary_key_missing_column')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
