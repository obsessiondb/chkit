import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  quoteIdent,
  runCli,
  runCliWithRetry,
  waitForColumn,
  waitForRows,
  waitForCliJson,
  waitForTable,
  waitForView,
} from './e2e-testkit.js'

function renderBaseSchema(database: string, usersTableName: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: '${usersTableName}',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`
}

function renderUniqueProjectionSchema(database: string, usersTableName: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: '${usersTableName}',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n  uniqueKey: ['id'],\n  projections: [{ name: 'p_recent', query: 'SELECT id ORDER BY id DESC LIMIT 10' }],\n})\n\nexport default schema(users)\n`
}

function renderIndexedSchema(database: string, usersTableName: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: '${usersTableName}',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n  indexes: [\n    { name: 'idx_set', expression: 'email', type: 'set', maxRows: 0, granularity: 1 },\n    { name: 'idx_bloom', expression: 'email', type: 'bloom_filter', falsePositiveRate: 0.01, granularity: 1 },\n    { name: 'idx_ngram', expression: 'lower(email)', type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 4096, hashFunctions: 2, randomSeed: 0, granularity: 1 },\n  ],\n})\n\nexport default schema(users)\n`
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

  const { clickhouseUrl, clickhouseUser, clickhousePassword } = getLiveEnv()

  await writeFile(schemaPath, renderBaseSchema(input.database, input.usersTableName), 'utf8')
  await writeFile(
    configPath,
    `export default {\n  schema: '${schemaPath}',\n  outDir: '${outDir}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${metaDir}',\n  clickhouse: {\n    url: '${clickhouseUrl}',\n    username: '${clickhouseUser}',\n    password: '${clickhousePassword}',\n    database: '${input.database}',\n  },\n}\n`,
    'utf8'
  )

  return { dir, configPath, schemaPath }
}

describe('@chkit/cli drift depth env e2e', () => {
  const liveEnv = getLiveEnv()

  test('inline Nullable types pass strict checks and real nullability or type changes drift', async () => {
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const usersTable = `${createPrefix('drift_nullable')}users`
    const journalTable = createJournalTableName('drift_nullable')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
    const fixture = await createFixture({ database, usersTableName: usersTable })
    const object = `${quoteIdent(database)}.${quoteIdent(usersTable)}`
    const args = ['--config', fixture.configPath, '--table', `${database}.${usersTable}`, '--json']

    try {
      await writeFile(fixture.schemaPath, `import { schema, table } from '${CORE_ENTRY}'
export default schema(table({
  database: '${database}', name: '${usersTable}', engine: 'MergeTree()', orderBy: ['id'],
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'note', type: 'Nullable(String)', default: 'new', comment: 'optional note' },
    { name: 'seen_at', type: "Nullable(DateTime64(3, 'UTC'))" },
    { name: 'amount', type: 'Nullable(Decimal(12, 3))' },
  ],
}))
`, 'utf8')
      const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
      if (generated.exitCode !== 0) throw new Error(formatTestDiagnostic('nullable generate failed', generated))
      expect(generated.exitCode).toBe(0)
      const migrated = await runCliWithRetry(
        fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'], { extraEnv: cliEnv }
      )
      if (migrated.exitCode !== 0) throw new Error(formatTestDiagnostic('nullable migrate failed', migrated))
      await waitForTable(executor, database, usersTable)

      const drift = runCli(fixture.dir, ['drift', ...args], cliEnv)
      expect(drift.exitCode).toBe(0)
      expect(JSON.parse(drift.stdout)).toMatchObject({ drifted: false, tableDrift: [] })
      const check = runCli(fixture.dir, ['check', '--strict', ...args], cliEnv)
      expect(check.exitCode).toBe(0)
      expect(JSON.parse(check.stdout)).toMatchObject({ ok: true, drifted: false, failedChecks: [] })

      await executor.command(`ALTER TABLE ${object} MODIFY COLUMN note String`)
      await executor.command(`ALTER TABLE ${object} MODIFY COLUMN amount Nullable(Decimal(12, 4))`)
      await waitForRows<{ name: string; type: string }>(executor,
        `SELECT name, type FROM system.columns WHERE database = '${database}' AND table = '${usersTable}' AND name IN ('note', 'amount') ORDER BY name`,
        (rows) => rows[0]?.type === 'Nullable(Decimal(12, 4))' && rows[1]?.type === 'String',
        'nullable column changes'
      )
      const changed = runCli(fixture.dir, ['drift', ...args], cliEnv)
      expect(changed.exitCode).toBe(0)
      expect(JSON.parse(changed.stdout)).toMatchObject({
        drifted: true,
        tableDrift: [{ table: `${database}.${usersTable}`, changedColumns: ['amount', 'note'], reasonCodes: ['changed_column'] }],
      })
      const strict = runCli(fixture.dir, ['check', '--strict', ...args], cliEnv)
      expect(strict.exitCode).toBe(1)
      expect(JSON.parse(strict.stdout)).toMatchObject({ ok: false, drifted: true, failedChecks: ['schema_drift'] })
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${object}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      await executor.close()
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 240_000)

  test(
    'detects manual drift and exposes reason counts via drift/check JSON',
    async () => {
      const executor = createLiveExecutor(liveEnv)
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
        await waitForTable(executor, database, usersTable)

        await executor.command(
          `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(usersTable)} ADD COLUMN rogue String`
        )

        // Wait for the column to propagate (managed ClickHouse DDL is eventually consistent)
        await waitForColumn(executor, database, usersTable, 'rogue')

        await executor.command(
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
        await executor.command(`DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(manualView)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )

  test(
    'detects unique-key and projection drift reasons and exposes them in check summary',
    async () => {
      const executor = createLiveExecutor(liveEnv)
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
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )

  test(
    'respects failOnDrift=false policy when drift exists',
    async () => {
      const executor = createLiveExecutor(liveEnv)
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

        await waitForTable(executor, database, usersTable)

        await executor.command(
          `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(usersTable)} ADD COLUMN rogue String`
        )

        await waitForColumn(executor, database, usersTable, 'rogue')

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
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )

  test(
    'check --strict overrides failOnDrift=false when drift exists',
    async () => {
      const executor = createLiveExecutor(liveEnv)
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

        await waitForTable(executor, database, usersTable)

        await executor.command(
          `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(usersTable)} ADD COLUMN rogue String`
        )

        await waitForColumn(executor, database, usersTable, 'rogue')

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
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )

  test(
    'reports no drift for parameterised skipping indexes right after migrate',
    async () => {
      const executor = createLiveExecutor(liveEnv)
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('drift_index_args')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const prefix = createPrefix('drift_index_args')
      const usersTable = `${prefix}users`
      const fixture = await createFixture({ database, usersTableName: usersTable })

      try {
        await writeFile(fixture.schemaPath, renderIndexedSchema(database, usersTable), 'utf8')
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
        await waitForTable(executor, database, usersTable)

        const driftResult = runCli(
          fixture.dir,
          ['drift', '--config', fixture.configPath, '--table', `${database}.${usersTable}`, '--json'],
          cliEnv
        )
        expect(driftResult.exitCode).toBe(0)
        const driftPayload = JSON.parse(driftResult.stdout) as {
          drifted: boolean
          tableDrift: Array<{ table: string; reasonCodes: string[] }>
        }
        expect(driftPayload.tableDrift).toEqual([])
        expect(driftPayload.drifted).toBe(false)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )

  test('view and materialized view queries read clean after migrate, and a changed query or target drifts (#382)', async () => {
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const prefix = createPrefix('drift_views')
    const journalTable = createJournalTableName('drift_views')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
    const orders = `${prefix}orders`
    const byDay = `${prefix}by_day`
    const byDayAlt = `${prefix}by_day_alt`
    const report = `${prefix}report`
    const ordersMv = `${prefix}orders_mv`
    const statuses = `${prefix}statuses`
    const fixture = await createFixture({ database, usersTableName: orders })
    const q = (name: string) => `${quoteIdent(database)}.${quoteIdent(name)}`
    const mvQuery = `SELECT day, amount FROM ${quoteIdent(orders)} WHERE status != 'Refunded'`

    try {
      await writeFile(fixture.schemaPath, `import { dictionary, materializedView, schema, table, view } from '${CORE_ENTRY}'
const orders = table({
  database: '${database}', name: '${orders}', engine: 'MergeTree()', orderBy: ['id'],
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'day', type: 'Date' },
    { name: 'amount', type: 'UInt64' },
    { name: 'status', type: 'String' },
  ],
})
const byDay = (name) => table({
  database: '${database}', name, engine: 'MergeTree()', orderBy: ['day'],
  columns: [{ name: 'day', type: 'Date' }, { name: 'amount', type: 'UInt64' }],
})
const statuses = dictionary({
  database: '${database}', name: '${statuses}', primaryKey: ['id'],
  attributes: [{ name: 'id', type: 'UInt64' }, { name: 'status', type: 'String', default: '' }],
  source: "CLICKHOUSE(TABLE '${orders}' DB '${database}')", layout: 'FLAT()', lifetime: '0',
})
const report = view({
  database: '${database}', name: '${report}',
  as: \`WITH paid AS (SELECT id, day, amount FROM ${orders} WHERE status IN ('Paid','Shipped')) -- paid orders only
SELECT p.day AS day, sum(p.amount) AS revenue, arrayMap(x -> x*2, [1,2]) AS doubled, /* note */ count() AS n,
  max(dictGet('${statuses}', 'status', p.id)) AS last_status, countIf(dictHas('${statuses}', p.id)) AS known
FROM paid AS p
JOIN (SELECT day, count() AS c FROM ${orders} GROUP BY day) AS d ON p.day = d.day
WHERE p.id IN (SELECT id FROM ${database}.${orders} WHERE amount > 0)
GROUP BY p.day
SETTINGS max_threads = 2\`,
})
const ordersMv = materializedView({
  database: '${database}', name: '${ordersMv}', to: { database: '${database}', name: '${byDay}' },
  as: "${mvQuery}",
})
export default schema(orders, byDay('${byDay}'), byDay('${byDayAlt}'), statuses, report, ordersMv)
`, 'utf8')
      const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
      if (generated.exitCode !== 0) throw new Error(formatTestDiagnostic('views generate failed', generated))
      const migrated = await runCliWithRetry(
        fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'], { extraEnv: cliEnv }
      )
      if (migrated.exitCode !== 0) throw new Error(formatTestDiagnostic('views migrate failed', migrated))
      await waitForView(executor, database, report)
      await waitForView(executor, database, ordersMv)

      const clean = runCli(fixture.dir, ['drift', '--config', fixture.configPath, '--json'], cliEnv)
      expect(clean.exitCode).toBe(0)
      const cleanPayload = JSON.parse(clean.stdout) as { drifted: boolean; objectDrift: Array<{ code: string }>; tableDrift: unknown[] }
      // A shared test database holds other runs' objects, reported as extra_object.
      expect(cleanPayload).toMatchObject({ drifted: false, tableDrift: [] })
      expect(cleanPayload.objectDrift.filter((item) => item.code !== 'extra_object')).toEqual([])
      const cleanCheck = runCli(fixture.dir, ['check', '--strict', '--config', fixture.configPath, '--json'], cliEnv)
      expect(cleanCheck.exitCode).toBe(0)

      // DROP + CREATE rather than CREATE OR REPLACE, which ObsessionDB does not
      // apply on every replica.
      await executor.command(`DROP VIEW ${q(report)} SYNC`)
      await executor.command(`CREATE VIEW ${q(report)} AS SELECT day, sum(amount) AS revenue FROM ${q(orders)} WHERE status != 'Refunded' GROUP BY day`)
      await executor.command(`DROP VIEW ${q(ordersMv)} SYNC`)
      await executor.command(`CREATE MATERIALIZED VIEW ${q(ordersMv)} TO ${q(byDayAlt)} AS ${mvQuery} AND amount > 0`)

      const expectedDrift = [
        `query_mismatch ${database}.${ordersMv}`,
        `target_mismatch ${database}.${ordersMv}`,
        `query_mismatch ${database}.${report}`,
      ]
      type ViewDriftPayload = { drifted: boolean; objectDrift: Array<{ code: string; object: string; expected?: string; actual?: string }> }
      const { payload } = await waitForCliJson<ViewDriftPayload>(
        fixture.dir,
        ['drift', '--config', fixture.configPath, '--json'],
        (drift) =>
          JSON.stringify(
            drift.objectDrift.filter((item) => item.code !== 'extra_object').map((item) => `${item.code} ${item.object}`)
          ) === JSON.stringify(expectedDrift),
        { extraEnv: cliEnv, maxAttempts: 30 }
      )
      expect(payload.drifted).toBe(true)
      expect(payload.objectDrift.find((item) => item.code === 'target_mismatch')).toMatchObject({
        expected: `${database}.${byDay}`,
        actual: `${database}.${byDayAlt}`,
      })
      const strict = runCli(fixture.dir, ['check', '--strict', '--config', fixture.configPath, '--json'], cliEnv)
      expect(strict.exitCode).toBe(1)
      expect(JSON.parse(strict.stdout)).toMatchObject({
        ok: false,
        failedChecks: ['schema_drift'],
        driftReasonCounts: { query_mismatch: 2, target_mismatch: 1 },
      })
    } finally {
      await executor.command(`DROP VIEW IF EXISTS ${q(ordersMv)}`)
      await executor.command(`DROP VIEW IF EXISTS ${q(report)}`)
      await executor.command(`DROP DICTIONARY IF EXISTS ${q(statuses)}`)
      for (const name of [orders, byDay, byDayAlt, journalTable]) {
        await executor.command(`DROP TABLE IF EXISTS ${q(name)}`)
      }
      await executor.close()
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 240_000)
})
