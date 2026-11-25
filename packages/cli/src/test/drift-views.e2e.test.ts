import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { waitForDDLPropagation } from '@chkit/clickhouse'

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
  waitForCliJson,
  waitForView,
} from './e2e-testkit.js'
import { createFixture } from './drift-fixture.js'

describe('@chkit/cli drift depth env e2e', () => {
  const liveEnv = getLiveEnv()

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
      // apply on every replica. Each CREATE waits for its DROP on every replica,
      // or it can land on one that still lists the view (#712).
      await executor.command(`DROP VIEW ${q(report)} SYNC`)
      await waitForDDLPropagation(executor, 'drop_view', `view:${database}.${report}`)
      await executor.command(`CREATE VIEW ${q(report)} AS SELECT day, sum(amount) AS revenue FROM ${q(orders)} WHERE status != 'Refunded' GROUP BY day`)
      await executor.command(`DROP VIEW ${q(ordersMv)} SYNC`)
      await waitForDDLPropagation(executor, 'drop_materialized_view', `materialized_view:${database}.${ordersMv}`)
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

  test('view queries with differently-cased function names and aliases read clean after migrate (#731)', async () => {
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const prefix = createPrefix('drift_fn_case')
    const journalTable = createJournalTableName('drift_fn_case')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
    const orders = `${prefix}orders`
    const report = `${prefix}report`
    const fixture = await createFixture({ database, usersTableName: orders })
    const q = (name: string) => `${quoteIdent(database)}.${quoteIdent(name)}`

    try {
      // ClickHouse stores FLOOR as floor and the alias CEILING as ceil, while
      // case-sensitive names such as toUnixTimestamp are stored as written.
      // Drift must converge the registered spellings without lowercasing
      // case-sensitive or unknown names.
      await writeFile(fixture.schemaPath, `import { schema, table, view } from '${CORE_ENTRY}'
const orders = table({
  database: '${database}', name: '${orders}', engine: 'MergeTree()', orderBy: ['id'],
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'amount', type: 'Float64' },
  ],
})
const report = view({
  database: '${database}', name: '${report}',
  as: 'SELECT FLOOR(amount) AS floored, CEILING(amount) AS ceiled, toUnixTimestamp(now64()) AS ts FROM ${orders}',
})
export default schema(orders, report)
`, 'utf8')
      const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
      if (generated.exitCode !== 0) throw new Error(formatTestDiagnostic('function-case generate failed', generated))
      const migrated = await runCliWithRetry(
        fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'], { extraEnv: cliEnv }
      )
      if (migrated.exitCode !== 0) throw new Error(formatTestDiagnostic('function-case migrate failed', migrated))
      await waitForView(executor, database, report)

      const clean = runCli(fixture.dir, ['drift', '--config', fixture.configPath, '--json'], cliEnv)
      expect(clean.exitCode).toBe(0)
      const cleanPayload = JSON.parse(clean.stdout) as {
        drifted: boolean
        objectDrift: Array<{ code: string }>
        tableDrift: unknown[]
      }
      // A shared test database holds other runs' objects, reported as extra_object.
      expect(cleanPayload).toMatchObject({ drifted: false, tableDrift: [] })
      expect(cleanPayload.objectDrift.filter((item) => item.code !== 'extra_object')).toEqual([])
      const cleanCheck = runCli(fixture.dir, ['check', '--strict', '--config', fixture.configPath, '--json'], cliEnv)
      expect(cleanCheck.exitCode).toBe(0)
    } finally {
      await executor.command(`DROP VIEW IF EXISTS ${q(report)}`)
      for (const name of [orders, journalTable]) {
        await executor.command(`DROP TABLE IF EXISTS ${q(name)}`)
      }
      await executor.close()
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 240_000)
})
