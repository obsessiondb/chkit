import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
const CLI_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chx.ts')
const CORE_ENTRY = join(WORKSPACE_ROOT, 'packages/core/src/index.ts')

function getRequiredEnv(): {
  clickhouseUrl: string
  clickhouseUser: string
  clickhousePassword: string
} {
  const clickhouseHost = process.env.CLICKHOUSE_HOST?.trim()
  const clickhouseUrl =
    process.env.CLICKHOUSE_URL?.trim() || (clickhouseHost ? `https://${clickhouseHost}` : '')
  const clickhouseUser = process.env.CLICKHOUSE_USER?.trim() || 'default'
  const clickhousePassword = process.env.CLICKHOUSE_PASSWORD?.trim() || ''

  if (!clickhouseUrl) {
    throw new Error('Missing CLICKHOUSE_URL or CLICKHOUSE_HOST')
  }

  if (!clickhousePassword) {
    throw new Error('Missing CLICKHOUSE_PASSWORD')
  }

  return { clickhouseUrl, clickhouseUser, clickhousePassword }
}

function runCli(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ['bun', CLI_ENTRY, ...args],
    cwd,
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

async function dropDatabase(url: string, username: string, password: string, database: string): Promise<void> {
  const auth = Buffer.from(`${username}:${password}`).toString('base64')
  await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'text/plain',
    },
    body: `DROP DATABASE IF EXISTS ${database}`,
  })
}

function renderBaseSchema(database: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`
}

function renderEvolvedSchema(database: string): string {
  return `import { schema, table, view } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n    { name: 'source', type: 'String', default: 'web' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nconst usersView = view({\n  database: '${database}',\n  name: 'users_view',\n  as: 'SELECT id, email, source FROM ${database}.users',\n})\n\nexport default schema(users, usersView)\n`
}

interface E2EFixture {
  dir: string
  configPath: string
  migrationsDir: string
  schemaPath: string
}

async function createFixture(database: string): Promise<E2EFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'chx-cli-e2e-'))
  const schemaPath = join(dir, 'schema.ts')
  const configPath = join(dir, 'clickhouse.config.ts')
  const outDir = join(dir, 'chx')
  const migrationsDir = join(outDir, 'migrations')
  const metaDir = join(outDir, 'meta')

  const { clickhouseUrl, clickhouseUser, clickhousePassword } = getRequiredEnv()

  await writeFile(schemaPath, renderBaseSchema(database), 'utf8')

  await writeFile(
    configPath,
    `export default {\n  schema: '${schemaPath}',\n  outDir: '${outDir}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${metaDir}',\n  clickhouse: {\n    url: '${clickhouseUrl}',\n    username: '${clickhouseUser}',\n    password: '${clickhousePassword}',\n    database: 'default',\n  },\n}\n`,
    'utf8'
  )

  return { dir, configPath, migrationsDir, schemaPath }
}

describe('@chx/cli doppler env e2e', () => {
  const liveEnv = getRequiredEnv()

  test('validates required env variables are present', () => {
    expect(() => getRequiredEnv()).not.toThrow()
  })

  test(
    'runs init + generate + migrate + status against live ClickHouse',
    async () => {
    const dbSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const database = `chx_e2e_${dbSuffix}`
    const fixture = await createFixture(database)
    const { clickhouseUrl, clickhouseUser, clickhousePassword } = liveEnv

    try {
      const initResult = runCli(fixture.dir, ['init'])
      expect(initResult.exitCode).toBe(0)

      const generateResult = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'])
      expect(generateResult.exitCode).toBe(0)
      const generatePayload = JSON.parse(generateResult.stdout) as { migrationFile: string | null }
      expect(generatePayload.migrationFile).toBeTruthy()
      if (!generatePayload.migrationFile) {
        throw new Error('expected generated migration file')
      }

      const planResult = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--json'])
      expect(planResult.exitCode).toBe(0)
      const planPayload = JSON.parse(planResult.stdout) as { pending: string[] }
      expect(planPayload.pending.length).toBe(1)

      const executeResult = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'])
      if (executeResult.exitCode !== 0) {
        throw new Error(
          `migrate --execute failed (exit=${executeResult.exitCode})\nstdout:\n${executeResult.stdout}\nstderr:\n${executeResult.stderr}`
        )
      }
      expect(executeResult.exitCode).toBe(0)
      const executePayload = JSON.parse(executeResult.stdout) as {
        mode: string
        applied: Array<{ name: string }>
      }
      expect(executePayload.mode).toBe('execute')
      expect(executePayload.applied.length).toBe(1)

      const statusResult = runCli(fixture.dir, ['status', '--config', fixture.configPath, '--json'])
      expect(statusResult.exitCode).toBe(0)
      const statusPayload = JSON.parse(statusResult.stdout) as {
        total: number
        applied: number
        pending: number
        checksumMismatchCount: number
      }
      expect(statusPayload.total).toBe(1)
      expect(statusPayload.applied).toBe(1)
      expect(statusPayload.pending).toBe(0)
      expect(statusPayload.checksumMismatchCount).toBe(0)

      const generatedSqlPath = generatePayload.migrationFile.startsWith('/')
        ? generatePayload.migrationFile
        : join(fixture.migrationsDir, generatePayload.migrationFile)
      const generatedSql = await readFile(generatedSqlPath, 'utf8')
      expect(generatedSql.length).toBeGreaterThan(0)
    } finally {
      try {
        await dropDatabase(clickhouseUrl, clickhouseUser, clickhousePassword, database)
      } catch {
        // Best-effort cleanup for shared e2e environment.
      }
      await rm(fixture.dir, { recursive: true, force: true })
    }
    },
    240_000
  )

  test(
    'runs additive second migration cycle in a separate project flow',
    async () => {
      const dbSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`
      const database = `chx_e2e_additive_${dbSuffix}`
      const fixture = await createFixture(database)
      const { clickhouseUrl, clickhouseUser, clickhousePassword } = liveEnv

      try {
        const firstGenerate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'])
        expect(firstGenerate.exitCode).toBe(0)

        const firstExecute = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'])
        if (firstExecute.exitCode !== 0) {
          throw new Error(
            `first migrate --execute failed (exit=${firstExecute.exitCode})\nstdout:\n${firstExecute.stdout}\nstderr:\n${firstExecute.stderr}`
          )
        }
        expect(firstExecute.exitCode).toBe(0)

        await writeFile(fixture.schemaPath, renderEvolvedSchema(database), 'utf8')

        const secondGenerate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'])
        expect(secondGenerate.exitCode).toBe(0)
        const secondGeneratePayload = JSON.parse(secondGenerate.stdout) as {
          operationCount: number
          migrationFile: string | null
        }
        expect(secondGeneratePayload.operationCount).toBeGreaterThan(0)
        expect(secondGeneratePayload.migrationFile).toBeTruthy()

        const secondPlan = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--json'])
        expect(secondPlan.exitCode).toBe(0)
        const secondPlanPayload = JSON.parse(secondPlan.stdout) as { pending: string[] }
        expect(secondPlanPayload.pending.length).toBe(1)

        const secondExecute = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'])
        if (secondExecute.exitCode !== 0) {
          throw new Error(
            `second migrate --execute failed (exit=${secondExecute.exitCode})\nstdout:\n${secondExecute.stdout}\nstderr:\n${secondExecute.stderr}`
          )
        }
        expect(secondExecute.exitCode).toBe(0)

        const statusResult = runCli(fixture.dir, ['status', '--config', fixture.configPath, '--json'])
        expect(statusResult.exitCode).toBe(0)
        const statusPayload = JSON.parse(statusResult.stdout) as {
          total: number
          applied: number
          pending: number
        }
        expect(statusPayload.total).toBe(2)
        expect(statusPayload.applied).toBe(2)
        expect(statusPayload.pending).toBe(0)
      } finally {
        try {
          await dropDatabase(clickhouseUrl, clickhouseUser, clickhousePassword, database)
        } catch {
          // Best-effort cleanup for shared e2e environment.
        }
        await rm(fixture.dir, { recursive: true, force: true })
      }
    },
    240_000
  )

  test(
    'runs non-danger additive migrate path and ends with successful check',
    async () => {
      const dbSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`
      const database = `chx_e2e_check_${dbSuffix}`
      const fixture = await createFixture(database)
      const { clickhouseUrl, clickhouseUser, clickhousePassword } = liveEnv

      try {
        const firstGenerate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'])
        expect(firstGenerate.exitCode).toBe(0)
        const firstExecute = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'])
        if (firstExecute.exitCode !== 0) {
          throw new Error(
            `first migrate --execute failed (exit=${firstExecute.exitCode})\nstdout:\n${firstExecute.stdout}\nstderr:\n${firstExecute.stderr}`
          )
        }

        await writeFile(fixture.schemaPath, renderEvolvedSchema(database), 'utf8')

        const secondPlan = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--dryrun', '--json'])
        expect(secondPlan.exitCode).toBe(0)
        const secondPlanPayload = JSON.parse(secondPlan.stdout) as {
          operations: Array<{ type: string }>
        }
        expect(secondPlanPayload.operations.some((op) => op.type === 'drop_table')).toBe(false)

        const secondGenerate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'])
        expect(secondGenerate.exitCode).toBe(0)
        const secondGeneratePayload = JSON.parse(secondGenerate.stdout) as { operationCount: number }
        expect(secondGeneratePayload.operationCount).toBeGreaterThan(0)

        const secondExecute = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'])
        if (secondExecute.exitCode !== 0) {
          throw new Error(
            `second migrate --execute failed (exit=${secondExecute.exitCode})\nstdout:\n${secondExecute.stdout}\nstderr:\n${secondExecute.stderr}`
          )
        }

        const check = runCli(fixture.dir, ['check', '--config', fixture.configPath, '--json'])
        expect(check.exitCode).toBe(0)
        const checkPayload = JSON.parse(check.stdout) as {
          ok: boolean
          failedChecks: string[]
          pendingCount: number
          checksumMismatchCount: number
          driftEvaluated: boolean
          drifted: boolean
        }
        expect(checkPayload.ok).toBe(true)
        expect(checkPayload.failedChecks).toEqual([])
        expect(checkPayload.pendingCount).toBe(0)
        expect(checkPayload.checksumMismatchCount).toBe(0)
        expect(checkPayload.driftEvaluated).toBe(true)
        expect(checkPayload.drifted).toBe(false)
      } finally {
        try {
          await dropDatabase(clickhouseUrl, clickhouseUser, clickhousePassword, database)
        } catch {
          // Best-effort cleanup for shared e2e environment.
        }
        await rm(fixture.dir, { recursive: true, force: true })
      }
    },
    240_000
  )

})
