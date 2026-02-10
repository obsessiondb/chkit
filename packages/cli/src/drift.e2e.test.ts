import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

function tryGetEnv(): ReturnType<typeof getRequiredEnv> | null {
  try {
    return getRequiredEnv()
  } catch {
    return null
  }
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

async function runSql(url: string, username: string, password: string, sql: string): Promise<void> {
  const auth = Buffer.from(`${username}:${password}`).toString('base64')
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'text/plain',
    },
    body: sql,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`ClickHouse SQL failed (${response.status}): ${body}`)
  }
}

async function dropDatabase(url: string, username: string, password: string, database: string): Promise<void> {
  await runSql(url, username, password, `DROP DATABASE IF EXISTS ${database}`)
}

function renderBaseSchema(database: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`
}

function renderUniqueProjectionSchema(database: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n  uniqueKey: ['id'],\n  projections: [{ name: 'p_recent', query: 'SELECT id ORDER BY id DESC LIMIT 10' }],\n})\n\nexport default schema(users)\n`
}

interface E2EFixture {
  dir: string
  configPath: string
}

async function createFixture(database: string): Promise<E2EFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'chx-cli-drift-e2e-'))
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

  return { dir, configPath }
}

describe('@chx/cli drift depth env e2e', () => {
  const liveEnv = tryGetEnv()

  test(
    'detects manual drift and exposes reason counts via drift/check JSON',
    async () => {
      if (!liveEnv) return

      const dbSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`
      const database = `chx_e2e_drift_${dbSuffix}`
      const fixture = await createFixture(database)
      const { clickhouseUrl, clickhouseUser, clickhousePassword } = liveEnv

      try {
        const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'])
        expect(generated.exitCode).toBe(0)

        const executed = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'])
        if (executed.exitCode !== 0) {
          throw new Error(
            `migrate --execute failed (exit=${executed.exitCode})\nstdout:\n${executed.stdout}\nstderr:\n${executed.stderr}`
          )
        }

        await runSql(
          clickhouseUrl,
          clickhouseUser,
          clickhousePassword,
          `ALTER TABLE ${database}.users ADD COLUMN rogue String`
        )
        await runSql(
          clickhouseUrl,
          clickhouseUser,
          clickhousePassword,
          `CREATE VIEW ${database}.manual_view AS SELECT 1 AS one`
        )

        const driftResult = runCli(fixture.dir, ['drift', '--config', fixture.configPath, '--json'])
        expect(driftResult.exitCode).toBe(0)
        const driftPayload = JSON.parse(driftResult.stdout) as {
          drifted: boolean
          objectDrift: Array<{ code: string }>
          tableDrift: Array<{ table: string; reasonCodes: string[] }>
        }

        expect(driftPayload.drifted).toBe(true)
        expect(driftPayload.objectDrift.some((item) => item.code === 'extra_object')).toBe(true)
        const usersTableDrift = driftPayload.tableDrift.find((item) => item.table === `${database}.users`)
        expect(usersTableDrift).toBeTruthy()
        expect(usersTableDrift?.reasonCodes).toContain('extra_column')

        const checkResult = runCli(fixture.dir, ['check', '--config', fixture.configPath, '--json'])
        expect(checkResult.exitCode).toBe(1)
        const checkPayload = JSON.parse(checkResult.stdout) as {
          failedChecks: string[]
          driftReasonCounts: Record<string, number>
          driftReasonTotals: { total: number; object: number; table: number }
        }

        expect(checkPayload.failedChecks).toContain('schema_drift')
        expect((checkPayload.driftReasonCounts.extra_object ?? 0) > 0).toBe(true)
        expect((checkPayload.driftReasonCounts.extra_column ?? 0) > 0).toBe(true)
        expect(checkPayload.driftReasonTotals.total > 0).toBe(true)
        expect(checkPayload.driftReasonTotals.object > 0).toBe(true)
        expect(checkPayload.driftReasonTotals.table > 0).toBe(true)
      } finally {
        try {
          await dropDatabase(clickhouseUrl, clickhouseUser, clickhousePassword, database)
        } catch {
          // best effort cleanup for shared env
        }
        await rm(fixture.dir, { recursive: true, force: true })
      }
    },
    240_000
  )

  test(
    'detects unique-key and projection drift reasons and exposes them in check summary',
    async () => {
      if (!liveEnv) return

      const dbSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`
      const database = `chx_e2e_drift_keys_${dbSuffix}`
      const fixture = await createFixture(database)
      const { clickhouseUrl, clickhouseUser, clickhousePassword } = liveEnv

      try {
        const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'])
        expect(generated.exitCode).toBe(0)

        const executed = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'])
        if (executed.exitCode !== 0) {
          throw new Error(
            `migrate --execute failed (exit=${executed.exitCode})\nstdout:\n${executed.stdout}\nstderr:\n${executed.stderr}`
          )
        }

        await writeFile(fixture.dir + '/schema.ts', renderUniqueProjectionSchema(database), 'utf8')
        const driftGenerate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'])
        expect(driftGenerate.exitCode).toBe(0)

        const driftResult = runCli(fixture.dir, ['drift', '--config', fixture.configPath, '--json'])
        expect(driftResult.exitCode).toBe(0)
        const driftPayload = JSON.parse(driftResult.stdout) as {
          drifted: boolean
          tableDrift: Array<{ table: string; reasonCodes: string[] }>
        }

        expect(driftPayload.drifted).toBe(true)
        const usersTableDrift = driftPayload.tableDrift.find((item) => item.table === `${database}.users`)
        expect(usersTableDrift).toBeTruthy()
        expect(usersTableDrift?.reasonCodes).toContain('unique_key_mismatch')
        expect(usersTableDrift?.reasonCodes).toContain('projection_mismatch')

        const checkResult = runCli(fixture.dir, ['check', '--config', fixture.configPath, '--json'])
        expect(checkResult.exitCode).toBe(1)
        const checkPayload = JSON.parse(checkResult.stdout) as {
          driftReasonCounts: Record<string, number>
        }
        expect((checkPayload.driftReasonCounts.unique_key_mismatch ?? 0) > 0).toBe(true)
        expect((checkPayload.driftReasonCounts.projection_mismatch ?? 0) > 0).toBe(true)
      } finally {
        try {
          await dropDatabase(clickhouseUrl, clickhouseUser, clickhousePassword, database)
        } catch {
          // best effort cleanup for shared env
        }
        await rm(fixture.dir, { recursive: true, force: true })
      }
    },
    240_000
  )
})
