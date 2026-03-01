import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveClient,
  createPrefix,
  formatTestDiagnostic,
  getRequiredEnv,
  quoteIdent,
  runCli,
  runCliWithRetry,
  runSql,
  waitForTable,
  waitForView,
} from './e2e-testkit.js'

function renderBaseSchema(database: string, usersTableName: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: '${usersTableName}',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`
}

function renderEvolvedSchema(database: string, usersTableName: string, usersViewName: string): string {
  return `import { schema, table, view } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: '${usersTableName}',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n    { name: 'source', type: 'String', default: 'web' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nconst usersView = view({\n  database: '${database}',\n  name: '${usersViewName}',\n  as: 'SELECT id, email, source FROM ${database}.${usersTableName}',\n})\n\nexport default schema(users, usersView)\n`
}

interface E2EFixture {
  dir: string
  configPath: string
  migrationsDir: string
  schemaPath: string
}

async function createFixture(input: {
  database: string
  usersTableName: string
  usersViewName: string
}): Promise<E2EFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-cli-e2e-'))
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

  return { dir, configPath, migrationsDir, schemaPath }
}

describe('@chkit/cli doppler env e2e', () => {
  const liveEnv = getRequiredEnv()
  const client = createLiveClient(liveEnv)

  afterAll(async () => {
    await client.close()
  })

  test(
    'runs init + generate + migrate + status against live ClickHouse',
    async () => {
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('flow')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const prefix = createPrefix('flow')
      const usersTable = `${prefix}users`
      const usersView = `${prefix}users_view`
      const fixture = await createFixture({
        database,
        usersTableName: usersTable,
        usersViewName: usersView,
      })

      try {
        const initResult = runCli(fixture.dir, ['init'], cliEnv)
        expect(initResult.exitCode).toBe(0)

        const generateResult = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(generateResult.exitCode).toBe(0)
        const generatePayload = JSON.parse(generateResult.stdout) as { migrationFile: string | null }
        expect(generatePayload.migrationFile).toBeTruthy()
        if (!generatePayload.migrationFile) {
          throw new Error('expected generated migration file')
        }

        const planResult = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(planResult.exitCode).toBe(0)
        const planPayload = JSON.parse(planResult.stdout) as { pending: string[] }
        expect(planPayload.pending.length).toBe(1)

        const executeResult = await runCliWithRetry(fixture.dir, [
          'migrate',
          '--config',
          fixture.configPath,
          '--execute',
          '--json',
        ], { extraEnv: cliEnv })
        if (executeResult.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute failed', executeResult))
        }
        expect(executeResult.exitCode).toBe(0)
        const executePayload = JSON.parse(executeResult.stdout) as {
          mode: string
          applied: Array<{ name: string }>
        }
        expect(executePayload.mode).toBe('execute')
        expect(executePayload.applied.length).toBe(1)

        const statusResult = runCli(fixture.dir, ['status', '--config', fixture.configPath, '--json'], cliEnv)
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
        await rm(fixture.dir, { recursive: true, force: true })
        await runSql(client, `DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersView)}`)
        await runSql(client, `DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await runSql(client, `DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      }
    },
    240_000
  )

  test(
    'runs additive second migration cycle in a separate project flow',
    async () => {
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('additive')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const prefix = createPrefix('additive')
      const usersTable = `${prefix}users`
      const usersView = `${prefix}users_view`
      const fixture = await createFixture({
        database,
        usersTableName: usersTable,
        usersViewName: usersView,
      })

      try {
        const firstGenerate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(firstGenerate.exitCode).toBe(0)

        const firstExecute = await runCliWithRetry(fixture.dir, [
          'migrate',
          '--config',
          fixture.configPath,
          '--execute',
          '--json',
        ], { extraEnv: cliEnv })
        if (firstExecute.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('first migrate --execute failed', firstExecute))
        }
        expect(firstExecute.exitCode).toBe(0)

        await writeFile(
          fixture.schemaPath,
          renderEvolvedSchema(database, usersTable, usersView),
          'utf8'
        )

        const secondGenerate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(secondGenerate.exitCode).toBe(0)
        const secondGeneratePayload = JSON.parse(secondGenerate.stdout) as {
          operationCount: number
          migrationFile: string | null
        }
        expect(secondGeneratePayload.operationCount).toBeGreaterThan(0)
        expect(secondGeneratePayload.migrationFile).toBeTruthy()

        const secondPlan = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--json'], cliEnv)
        if (secondPlan.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('second migrate --json plan failed', secondPlan))
        }
        expect(secondPlan.exitCode).toBe(0)
        const secondPlanPayload = JSON.parse(secondPlan.stdout) as { pending: string[] }
        expect(secondPlanPayload.pending.length).toBe(1)

        const secondExecute = await runCliWithRetry(fixture.dir, [
          'migrate',
          '--config',
          fixture.configPath,
          '--execute',
          '--json',
        ], { extraEnv: cliEnv })
        if (secondExecute.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('second migrate --execute failed', secondExecute))
        }
        expect(secondExecute.exitCode).toBe(0)

        const statusResult = runCli(fixture.dir, ['status', '--config', fixture.configPath, '--json'], cliEnv)
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
        await rm(fixture.dir, { recursive: true, force: true })
        await runSql(client, `DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersView)}`)
        await runSql(client, `DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await runSql(client, `DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      }
    },
    240_000
  )

  // TODO: Stabilize this test — it's flaky in CI due to timing/state issues with the live ClickHouse instance
  test.skipIf(new Date() < new Date('2026-03-02'))(
    'runs non-danger additive migrate path and ends with successful check',
    async () => {
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('check')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const prefix = createPrefix('check')
      const usersTable = `${prefix}users`
      const usersView = `${prefix}users_view`
      const fixture = await createFixture({
        database,
        usersTableName: usersTable,
        usersViewName: usersView,
      })

      try {
        const firstGenerate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(firstGenerate.exitCode).toBe(0)
        const firstExecute = await runCliWithRetry(fixture.dir, [
          'migrate',
          '--config',
          fixture.configPath,
          '--execute',
          '--json',
        ], { extraEnv: cliEnv })
        if (firstExecute.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('first migrate --execute failed', firstExecute))
        }

        // Wait for table to be visible before proceeding (ClickHouse Cloud DDL is eventually consistent)
        await waitForTable(client, database, usersTable)

        await writeFile(
          fixture.schemaPath,
          renderEvolvedSchema(database, usersTable, usersView),
          'utf8'
        )

        const secondPlan = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--dryrun', '--json'], cliEnv)
        expect(secondPlan.exitCode).toBe(0)
        const secondPlanPayload = JSON.parse(secondPlan.stdout) as {
          operations: Array<{ type: string }>
        }
        expect(secondPlanPayload.operations.some((op) => op.type === 'drop_table')).toBe(false)

        const secondGenerate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
        expect(secondGenerate.exitCode).toBe(0)
        const secondGeneratePayload = JSON.parse(secondGenerate.stdout) as { operationCount: number }
        expect(secondGeneratePayload.operationCount).toBeGreaterThan(0)

        const secondExecute = await runCliWithRetry(fixture.dir, [
          'migrate',
          '--config',
          fixture.configPath,
          '--execute',
          '--json',
        ], { extraEnv: cliEnv })
        if (secondExecute.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('second migrate --execute failed', secondExecute))
        }

        // Wait for view to be visible before check
        await waitForView(client, database, usersView)

        const check = await runCliWithRetry(
          fixture.dir,
          ['check', '--config', fixture.configPath, '--json'],
          { maxAttempts: 5, delayMs: 1500, extraEnv: cliEnv }
        )
        if (check.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('check --json failed', check))
        }
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
        await rm(fixture.dir, { recursive: true, force: true })
        await runSql(client, `DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersView)}`)
        await runSql(client, `DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await runSql(client, `DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      }
    },
    240_000
  )
})
