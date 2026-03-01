import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getRequiredEnv,
  quoteIdent,
  runCli,
  runCliWithRetry,
  waitForColumn,
  waitForTable,
} from './e2e-testkit.js'

function renderBaseSchema(database: string, usersTableName: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: '${usersTableName}',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`
}

function renderUniqueProjectionSchema(database: string, usersTableName: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: '${usersTableName}',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n  uniqueKey: ['id'],\n  projections: [{ name: 'p_recent', query: 'SELECT id ORDER BY id DESC LIMIT 10' }],\n})\n\nexport default schema(users)\n`
}

interface E2EFixture {
  dir: string
  configPath: string
  schemaPath: string
}

async function createFixture(input: {
  database: string
  usersTableName: string
}): Promise<E2EFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-cli-drift-e2e-'))
  const schemaPath = join(dir, 'schema.ts')
  const configPath = join(dir, 'clickhouse.config.ts')
  const outDir = join(dir, 'chkit')
  const migrationsDir = join(outDir, 'migrations')
  const metaDir = join(outDir, 'meta')

  const { clickhouseUrl, clickhouseUser, clickhousePassword } = getRequiredEnv()

  await writeFile(schemaPath, renderBaseSchema(input.database, input.usersTableName), 'utf8')
  await writeFile(
    configPath,
    `export default {\n  schema: '${schemaPath}',\n  outDir: '${outDir}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${metaDir}',\n  clickhouse: {\n    url: '${clickhouseUrl}',\n    username: '${clickhouseUser}',\n    password: '${clickhousePassword}',\n    database: '${input.database}',\n  },\n}\n`,
    'utf8'
  )

  return { dir, configPath, schemaPath }
}

describe('@chkit/cli drift depth env e2e', () => {
  const liveEnv = getRequiredEnv()
  const executor = createLiveExecutor(liveEnv)

  afterAll(async () => {
    await executor.close()
  })

  test(
    'detects manual drift and exposes reason counts via drift/check JSON',
    async () => {
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('drift_manual')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const prefix = createPrefix('drift_manual')
      const usersTable = `${prefix}users`
      const manualView = `${prefix}manual_view`
      const fixture = await createFixture({
        database,
        usersTableName: usersTable,
      })

      try {
        const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(generated.exitCode).toBe(0)

        const executed = await runCliWithRetry(
          fixture.dir,
          ['migrate', '--config', fixture.configPath, '--execute', '--json'],
          { extraEnv: cliEnv }
        )
        if (executed.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute failed', executed))
        }

        // Wait for the table to be visible before altering it
        await waitForTable(executor,database, usersTable)

        await executor.execute(
          `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(usersTable)} ADD COLUMN rogue String`
        )

        // Wait for the column to propagate (ClickHouse Cloud DDL is eventually consistent)
        await waitForColumn(executor,database, usersTable, 'rogue')

        await executor.execute(
          `CREATE VIEW ${quoteIdent(database)}.${quoteIdent(manualView)} AS SELECT 1 AS one`
        )

        const driftResult = runCli(fixture.dir, ['drift', '--config', fixture.configPath, '--json'], cliEnv)
        expect(driftResult.exitCode).toBe(0)
        const driftPayload = JSON.parse(driftResult.stdout) as {
          drifted: boolean
          objectDrift: Array<{ code: string }>
          tableDrift: Array<{ table: string; reasonCodes: string[] }>
        }

        expect(driftPayload.drifted).toBe(true)
        expect(driftPayload.objectDrift.some((item) => item.code === 'extra_object')).toBe(true)
        const usersTableDrift = driftPayload.tableDrift.find((item) => item.table === `${database}.${usersTable}`)
        expect(usersTableDrift).toBeTruthy()
        expect(usersTableDrift?.reasonCodes).toContain('extra_column')

        const checkResult = runCli(fixture.dir, ['check', '--config', fixture.configPath, '--json'], cliEnv)
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
        await rm(fixture.dir, { recursive: true, force: true })
        await executor.execute(`DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(manualView)}`)
        await executor.execute(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.execute(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      }
    },
    240_000
  )

  test(
    'detects unique-key and projection drift reasons and exposes them in check summary',
    async () => {
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('drift_keys')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const prefix = createPrefix('drift_keys')
      const usersTable = `${prefix}users`
      const fixture = await createFixture({
        database,
        usersTableName: usersTable,
      })

      try {
        const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(generated.exitCode).toBe(0)

        const executed = await runCliWithRetry(
          fixture.dir,
          ['migrate', '--config', fixture.configPath, '--execute', '--json'],
          { extraEnv: cliEnv }
        )
        if (executed.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute failed', executed))
        }

        await writeFile(
          fixture.schemaPath,
          renderUniqueProjectionSchema(database, usersTable),
          'utf8'
        )
        const driftGenerate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(driftGenerate.exitCode).toBe(0)

        const driftResult = runCli(fixture.dir, ['drift', '--config', fixture.configPath, '--json'], cliEnv)
        expect(driftResult.exitCode).toBe(0)
        const driftPayload = JSON.parse(driftResult.stdout) as {
          drifted: boolean
          tableDrift: Array<{ table: string; reasonCodes: string[] }>
        }

        expect(driftPayload.drifted).toBe(true)
        const usersTableDrift = driftPayload.tableDrift.find((item) => item.table === `${database}.${usersTable}`)
        expect(usersTableDrift).toBeTruthy()
        expect(usersTableDrift?.reasonCodes).toContain('unique_key_mismatch')
        expect(usersTableDrift?.reasonCodes).toContain('projection_mismatch')

        const checkResult = runCli(fixture.dir, ['check', '--config', fixture.configPath, '--json'], cliEnv)
        expect(checkResult.exitCode).toBe(1)
        const checkPayload = JSON.parse(checkResult.stdout) as {
          driftReasonCounts: Record<string, number>
        }
        expect((checkPayload.driftReasonCounts.unique_key_mismatch ?? 0) > 0).toBe(true)
        expect((checkPayload.driftReasonCounts.projection_mismatch ?? 0) > 0).toBe(true)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
        await executor.execute(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.execute(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      }
    },
    240_000
  )

  test(
    'respects failOnDrift=false policy when drift exists',
    async () => {
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('drift_policy')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const prefix = createPrefix('drift_policy')
      const usersTable = `${prefix}users`
      const fixture = await createFixture({
        database,
        usersTableName: usersTable,
      })

      try {
        const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(generated.exitCode).toBe(0)

        const executed = await runCliWithRetry(
          fixture.dir,
          ['migrate', '--config', fixture.configPath, '--execute', '--json'],
          { extraEnv: cliEnv }
        )
        if (executed.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute failed', executed))
        }

        await waitForTable(executor,database, usersTable)

        await executor.execute(
          `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(usersTable)} ADD COLUMN rogue String`
        )

        await waitForColumn(executor,database, usersTable, 'rogue')

        await writeFile(
          fixture.configPath,
          `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${join(fixture.dir, 'chkit/migrations')}',\n  metaDir: '${join(fixture.dir, 'chkit/meta')}',\n  clickhouse: {\n    url: '${liveEnv.clickhouseUrl}',\n    username: '${liveEnv.clickhouseUser}',\n    password: '${liveEnv.clickhousePassword}',\n    database: '${database}',\n  },\n  check: {\n    failOnDrift: false,\n  },\n}\n`,
          'utf8'
        )

        const checkResult = runCli(fixture.dir, ['check', '--config', fixture.configPath, '--json'], cliEnv)
        expect(checkResult.exitCode).toBe(0)
        const checkPayload = JSON.parse(checkResult.stdout) as {
          ok: boolean
          drifted: boolean
          failedChecks: string[]
          policy: { failOnDrift: boolean }
        }
        expect(checkPayload.ok).toBe(true)
        expect(checkPayload.drifted).toBe(true)
        expect(checkPayload.policy.failOnDrift).toBe(false)
        expect(checkPayload.failedChecks).not.toContain('schema_drift')
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
        await executor.execute(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.execute(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      }
    },
    240_000
  )

  test(
    'check --strict overrides failOnDrift=false when drift exists',
    async () => {
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('drift_strict')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const prefix = createPrefix('drift_strict')
      const usersTable = `${prefix}users`
      const fixture = await createFixture({
        database,
        usersTableName: usersTable,
      })

      try {
        const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(generated.exitCode).toBe(0)

        const executed = await runCliWithRetry(
          fixture.dir,
          ['migrate', '--config', fixture.configPath, '--execute', '--json'],
          { extraEnv: cliEnv }
        )
        if (executed.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute failed', executed))
        }

        await waitForTable(executor,database, usersTable)

        await executor.execute(
          `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(usersTable)} ADD COLUMN rogue String`
        )

        await waitForColumn(executor,database, usersTable, 'rogue')

        await writeFile(
          fixture.configPath,
          `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${join(fixture.dir, 'chkit/migrations')}',\n  metaDir: '${join(fixture.dir, 'chkit/meta')}',\n  clickhouse: {\n    url: '${liveEnv.clickhouseUrl}',\n    username: '${liveEnv.clickhouseUser}',\n    password: '${liveEnv.clickhousePassword}',\n    database: '${database}',\n  },\n  check: {\n    failOnDrift: false,\n  },\n}\n`,
          'utf8'
        )

        const checkResult = runCli(
          fixture.dir,
          ['check', '--config', fixture.configPath, '--strict', '--json'],
          cliEnv
        )
        expect(checkResult.exitCode).toBe(1)
        const checkPayload = JSON.parse(checkResult.stdout) as {
          strict: boolean
          ok: boolean
          drifted: boolean
          failedChecks: string[]
          policy: { failOnDrift: boolean }
        }
        expect(checkPayload.strict).toBe(true)
        expect(checkPayload.ok).toBe(false)
        expect(checkPayload.drifted).toBe(true)
        expect(checkPayload.policy.failOnDrift).toBe(true)
        expect(checkPayload.failedChecks).toContain('schema_drift')
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
        await executor.execute(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.execute(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      }
    },
    240_000
  )
})
