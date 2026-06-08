import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  createStatelessLiveExecutor,
  formatTestDiagnostic,
  getRequiredEnv,
  quoteIdent,
  runCli,
  runCliWithRetry,
  waitForCliJson,
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

  test(
    'runs init + generate + migrate + status against live ClickHouse',
    async () => {
      const executor = createLiveExecutor(liveEnv)
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

        const planResult = await runCliWithRetry(fixture.dir, [
          'migrate',
          '--config',
          fixture.configPath,
          '--json',
        ], { extraEnv: cliEnv })
        if (planResult.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --json plan failed', planResult))
        }
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
        await executor.command(`DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersView)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )

  test(
    'runs additive second migration cycle in a separate project flow',
    async () => {
      const executor = createLiveExecutor(liveEnv)
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

        const { payload: statusPayload } = await waitForCliJson<{
          total: number
          applied: number
          pending: number
        }>(
          fixture.dir,
          ['status', '--config', fixture.configPath, '--json'],
          (p) => p.applied === 2,
          { extraEnv: cliEnv }
        )
        expect(statusPayload.total).toBe(2)
        expect(statusPayload.applied).toBe(2)
        expect(statusPayload.pending).toBe(0)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
        await executor.command(`DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersView)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )

  test(
    'migrate applies table + materialized view without DDL race condition',
    async () => {
      const executor = createLiveExecutor(liveEnv)
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('ddlrace')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const prefix = createPrefix('ddl_race')
      const eventsTable = `${prefix}events`
      const eventCountsTable = `${prefix}event_counts`
      const eventCountsMv = `${prefix}event_counts_mv`

      const dir = await mkdtemp(join(tmpdir(), 'chkit-cli-e2e-ddlrace-'))
      const schemaPath = join(dir, 'schema.ts')
      const configPath = join(dir, 'clickhouse.config.ts')
      const outDir = join(dir, 'chkit')
      const migrationsDir = join(outDir, 'migrations')
      const metaDir = join(outDir, 'meta')

      const { clickhouseUrl, clickhouseUser, clickhousePassword } = getRequiredEnv()

      const schemaContent = `import { schema, table, materializedView } from '${CORE_ENTRY}'

const events = table({
  database: '${database}',
  name: '${eventsTable}',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'org_id', type: 'String' },
    { name: 'received_at', type: 'DateTime64(3)' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['org_id'],
  orderBy: ['org_id', 'received_at', 'id'],
})

const eventCounts = table({
  database: '${database}',
  name: '${eventCountsTable}',
  columns: [
    { name: 'org_id', type: 'String' },
    { name: 'total', type: 'UInt64' },
  ],
  engine: 'SummingMergeTree()',
  primaryKey: ['org_id'],
  orderBy: ['org_id'],
})

const eventCountsMv = materializedView({
  database: '${database}',
  name: '${eventCountsMv}',
  to: { database: '${database}', name: '${eventCountsTable}' },
  as: \`SELECT org_id, count() AS total FROM ${database}.${eventsTable} GROUP BY org_id\`,
})

export default schema(events, eventCounts, eventCountsMv)
`

      await writeFile(schemaPath, schemaContent, 'utf8')
      await writeFile(
        configPath,
        `export default {\n  schema: '${schemaPath}',\n  outDir: '${outDir}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${metaDir}',\n  clickhouse: {\n    url: '${clickhouseUrl}',\n    username: '${clickhouseUser}',\n    password: '${clickhousePassword}',\n    database: '${database}',\n  },\n}\n`,
        'utf8'
      )

      try {
        const generateResult = runCli(dir, ['generate', '--config', configPath, '--json'], cliEnv)
        expect(generateResult.exitCode).toBe(0)
        const generatePayload = JSON.parse(generateResult.stdout) as { migrationFile: string | null }
        expect(generatePayload.migrationFile).toBeTruthy()

        const executeResult = await runCliWithRetry(dir, [
          'migrate',
          '--config',
          configPath,
          '--execute',
          '--json',
        ], { extraEnv: cliEnv })
        if (executeResult.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute failed (DDL race test)', executeResult))
        }
        expect(executeResult.exitCode).toBe(0)
        const executePayload = JSON.parse(executeResult.stdout) as {
          mode: string
          applied: Array<{ name: string }>
        }
        expect(executePayload.mode).toBe('execute')
        expect(executePayload.applied.length).toBe(1)

        await waitForTable(executor, database, eventsTable)
        await waitForTable(executor, database, eventCountsTable)
        await waitForView(executor, database, eventCountsMv)
      } finally {
        await rm(dir, { recursive: true, force: true })
        await executor.command(`DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(eventCountsMv)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(eventCountsTable)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(eventsTable)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )

  test(
    'refreshable materialized view lifecycle: create → modify schedule → recreate → remove',
    async () => {
      const executor = createLiveExecutor(liveEnv)
      // Metadata polling below intentionally queries SHOW CREATE and system.tables
      // in parallel; use a stateless executor so those reads do not share one
      // ClickHouse HTTP session.
      const metadataExecutor = createStatelessLiveExecutor(liveEnv)
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('rmv')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const prefix = createPrefix('rmv')
      const targetTable = `${prefix}target`
      const rmvName = `${prefix}mv`

      const dir = await mkdtemp(join(tmpdir(), 'chkit-cli-e2e-rmv-'))
      const schemaPath = join(dir, 'schema.ts')
      const configPath = join(dir, 'clickhouse.config.ts')
      const outDir = join(dir, 'chkit')
      const migrationsDir = join(outDir, 'migrations')
      const metaDir = join(outDir, 'meta')

      const { clickhouseUrl, clickhouseUser, clickhousePassword } = getRequiredEnv()

      const renderSchema = (options: {
        includeRmv: boolean
        every?: string
        asQuery?: string
      }): string => {
        const targetDef = `const target = table({
  database: '${database}',
  name: '${targetTable}',
  columns: [
    { name: 'org_id', type: 'String' },
    { name: 'total', type: 'UInt64' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['org_id'],
  orderBy: ['org_id'],
})`
        if (!options.includeRmv) {
          return `import { schema, table } from '${CORE_ENTRY}'\n\n${targetDef}\n\nexport default schema(target)\n`
        }
        const every = options.every ?? '1 HOUR'
        const asQuery =
          options.asQuery ??
          `SELECT org_id, count() AS total FROM ${database}.${targetTable} GROUP BY org_id`
        return `import { schema, table, materializedView } from '${CORE_ENTRY}'

${targetDef}

const rmv = materializedView({
  database: '${database}',
  name: '${rmvName}',
  to: { database: '${database}', name: '${targetTable}' },
  refresh: {
    every: '${every}',
    append: true,
  },
  as: \`${asQuery}\`,
})

export default schema(target, rmv)
`
      }

      const writeSchema = (options: Parameters<typeof renderSchema>[0]) =>
        writeFile(schemaPath, renderSchema(options), 'utf8')

      await writeSchema({ includeRmv: true, every: '1 HOUR' })
      await writeFile(
        configPath,
        `export default {\n  schema: '${schemaPath}',\n  outDir: '${outDir}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${metaDir}',\n  clickhouse: {\n    url: '${clickhouseUrl}',\n    username: '${clickhouseUser}',\n    password: '${clickhousePassword}',\n    database: '${database}',\n  },\n}\n`,
        'utf8'
      )

      const queryCreate = async (): Promise<string | null> => {
        const rows = await metadataExecutor.query<{ create_table_query: string }>(
          `SELECT create_table_query FROM system.tables WHERE database = '${database}' AND name = '${rmvName}'`
        )
        return rows[0]?.create_table_query ?? null
      }

      const queryShowCreate = async (): Promise<string | null> => {
        try {
          const rows = await metadataExecutor.query<{ statement: string }>(
            `SHOW CREATE TABLE ${database}.${rmvName}`
          )
          return rows[0]?.statement ?? null
        } catch {
          return null
        }
      }

      // Both SHOW CREATE and system.tables.create_table_query can be stale on Cloud
      // after MODIFY REFRESH / DROP+CREATE. Combine them and poll up to timeoutMs for
      // the expected substring to appear in either.
      const waitForRmvContent = async (
        expected: string,
        timeoutMs = 60_000
      ): Promise<{ found: boolean; lastCombined: string }> => {
        const deadline = Date.now() + timeoutMs
        let lastCombined = ''
        while (Date.now() < deadline) {
          const [live, show] = await Promise.all([queryCreate(), queryShowCreate()])
          lastCombined = `${live ?? ''}\n---\n${show ?? ''}`
          if (lastCombined.includes(expected)) return { found: true, lastCombined }
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        return { found: false, lastCombined }
      }

      // An RMV is considered "gone" when its create_table_query is absent or empty AND
      // SHOW CREATE errors. system.tables row count alone is unreliable on Cloud —
      // zombie rows with empty create_table_query can linger for a minute during
      // SharedMergeTree replica convergence.
      const queryGone = async (): Promise<boolean> => {
        const live = await queryCreate()
        if (live && live.trim().length > 0) return false
        const show = await queryShowCreate()
        if (show && show.trim().length > 0) return false
        return true
      }

      try {
        // -------- Step 1: create target table + refreshable MV --------
        const gen1 = runCli(dir, ['generate', '--config', configPath, '--json'], cliEnv)
        if (gen1.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('generate step 1 failed', gen1))
        }
        const gen1Payload = JSON.parse(gen1.stdout) as {
          operationCount: number
          migrationFile: string | null
        }
        expect(gen1Payload.operationCount).toBeGreaterThan(0)
        expect(gen1Payload.migrationFile).toBeTruthy()
        if (!gen1Payload.migrationFile) {
          throw new Error('generate step 1 produced no migration file')
        }

        const migration1Sql = await readFile(
          gen1Payload.migrationFile.startsWith('/')
            ? gen1Payload.migrationFile
            : join(migrationsDir, gen1Payload.migrationFile),
          'utf8'
        )
        expect(migration1Sql).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS')
        expect(migration1Sql).toContain('REFRESH EVERY 1 HOUR')
        expect(migration1Sql).toContain('APPEND')

        const exec1 = await runCliWithRetry(
          dir,
          ['migrate', '--config', configPath, '--execute', '--json'],
          { extraEnv: cliEnv }
        )
        if (exec1.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate step 1 failed', exec1))
        }

        await waitForTable(executor, database, targetTable)
        await waitForView(executor, database, rmvName)

        const createSqlAfterStep1 = await queryCreate()
        expect(createSqlAfterStep1).toBeTruthy()
        expect(createSqlAfterStep1).toContain('REFRESH EVERY 1 HOUR')
        expect(createSqlAfterStep1).toContain('APPEND')

        // Refresh row exists in system.view_refreshes
        const refreshRows = await executor.query<{ c: string }>(
          `SELECT count() AS c FROM system.view_refreshes WHERE database = '${database}' AND view = '${rmvName}'`
        )
        expect((refreshRows[0]?.c ?? '0') !== '0').toBe(true)

        // -------- Step 2: schedule-only change → MODIFY REFRESH (preserves APPEND) --------
        await writeSchema({ includeRmv: true, every: '30 MINUTE' })

        // Dryrun first to assert the plan is exactly one MODIFY REFRESH op (Rules 1 & 2).
        const plan2 = runCli(dir, ['generate', '--config', configPath, '--dryrun', '--json'], cliEnv)
        if (plan2.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('generate --dryrun step 2 failed', plan2))
        }
        const plan2Payload = JSON.parse(plan2.stdout) as {
          operationCount: number
          operations: Array<{ type: string; sql: string }>
        }
        expect(plan2Payload.operationCount).toBe(1)
        expect(plan2Payload.operations[0]?.type).toBe('alter_materialized_view_modify_refresh')
        // Rule 2: APPEND must be re-included in MODIFY REFRESH for an APPEND MV.
        expect(plan2Payload.operations[0]?.sql).toContain('MODIFY REFRESH EVERY 30 MINUTE')
        expect(plan2Payload.operations[0]?.sql).toContain('APPEND')

        const gen2 = runCli(dir, ['generate', '--config', configPath, '--json'], cliEnv)
        if (gen2.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('generate step 2 failed', gen2))
        }
        const gen2Payload = JSON.parse(gen2.stdout) as {
          operationCount: number
          migrationFile: string | null
        }
        expect(gen2Payload.operationCount).toBe(1)

        const exec2 = await runCliWithRetry(
          dir,
          ['migrate', '--config', configPath, '--execute', '--json'],
          { extraEnv: cliEnv }
        )
        if (exec2.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate step 2 failed', exec2))
        }

        // SHOW CREATE and create_table_query can each be stale on Cloud for tens of
        // seconds after MODIFY REFRESH; poll both until one reflects the new schedule.
        const scheduleCheck = await waitForRmvContent('30 MINUTE')
        if (!scheduleCheck.found) {
          throw new Error(
            `MODIFY REFRESH not reflected in server metadata within 60s.\n${scheduleCheck.lastCombined}`
          )
        }
        expect(scheduleCheck.lastCombined).toContain('APPEND')

        // -------- Step 3: query change → drop + recreate --------
        await writeSchema({
          includeRmv: true,
          every: '30 MINUTE',
          asQuery: `SELECT org_id, count() * 2 AS total FROM ${database}.${targetTable} GROUP BY org_id`,
        })
        const plan3 = runCli(dir, ['generate', '--config', configPath, '--dryrun', '--json'], cliEnv)
        if (plan3.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('generate --dryrun step 3 failed', plan3))
        }
        const plan3Payload = JSON.parse(plan3.stdout) as {
          operationCount: number
          operations: Array<{ type: string }>
        }
        expect(plan3Payload.operationCount).toBe(2)
        expect(plan3Payload.operations.map((op) => op.type)).toEqual([
          'drop_materialized_view',
          'create_materialized_view',
        ])

        const gen3 = runCli(dir, ['generate', '--config', configPath, '--json'], cliEnv)
        if (gen3.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('generate step 3 failed', gen3))
        }

        const exec3 = await runCliWithRetry(
          dir,
          ['migrate', '--config', configPath, '--execute', '--json'],
          { extraEnv: cliEnv }
        )
        if (exec3.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate step 3 failed', exec3))
        }

        await waitForView(executor, database, rmvName)
        // After drop+recreate, poll both metadata sources for the new query — Cloud
        // caches may take tens of seconds to reflect the new CREATE across replicas.
        const recreateCheck = await waitForRmvContent('count() * 2')
        if (!recreateCheck.found) {
          throw new Error(
            `drop+recreate not reflected in server metadata within 60s.\n${recreateCheck.lastCombined}`
          )
        }
        expect(recreateCheck.lastCombined).toContain('REFRESH EVERY 30 MINUTE')
        expect(recreateCheck.lastCombined).toContain('APPEND')

        // -------- Step 4: remove RMV from schema → drop --------
        await writeSchema({ includeRmv: false })
        const plan4 = runCli(dir, ['generate', '--config', configPath, '--dryrun', '--json'], cliEnv)
        if (plan4.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('generate --dryrun step 4 failed', plan4))
        }
        const plan4Payload = JSON.parse(plan4.stdout) as {
          operationCount: number
          operations: Array<{ type: string }>
        }
        expect(plan4Payload.operationCount).toBe(1)
        expect(plan4Payload.operations[0]?.type).toBe('drop_materialized_view')

        const gen4 = runCli(dir, ['generate', '--config', configPath, '--json'], cliEnv)
        if (gen4.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('generate step 4 failed', gen4))
        }

        const exec4 = await runCliWithRetry(
          dir,
          [
            'migrate',
            '--config',
            configPath,
            '--execute',
            '--allow-destructive',
            '--json',
          ],
          { extraEnv: cliEnv }
        )
        if (exec4.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate step 4 failed', exec4))
        }

        // Poll until both SHOW CREATE and system.tables.create_table_query confirm the
        // RMV DDL is gone. Cloud DDL is eventually consistent; SharedMergeTree replicas
        // can take 30s+ to converge after a DROP.
        let gone = false
        for (let attempt = 0; attempt < 120; attempt += 1) {
          if (await queryGone()) {
            gone = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        if (!gone) {
          const lingering = await queryCreate()
          throw new Error(
            `RMV ${database}.${rmvName} DDL still present after drop + 60s polling.\nStep 4 stdout:\n${exec4.stdout}\nLingering create_table_query:\n${lingering}`
          )
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
        await executor.command(
          `DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(rmvName)} SYNC`
        )
        await executor.command(
          `DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(targetTable)}`
        )
        await executor.command(
          `DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`
        )
        await metadataExecutor.close()
        await executor.close()
      }
    },
    240_000
  )

  // TODO: Stabilize this test in CI by running it against an isolated database.
  // The shared CI database can contain objects from other test runs, and an
  // unscoped `check` correctly reports those as schema drift.
  test.skipIf(process.env.CI === 'true')(
    'runs non-danger additive migrate path and ends with successful check',
    async () => {
      const executor = createLiveExecutor(liveEnv)
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

        // Wait for table to be visible before proceeding (managed ClickHouse DDL is eventually consistent)
        await waitForTable(executor, database, usersTable)

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
        await waitForView(executor, database, usersView)

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
        await executor.command(`DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersView)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )
})
