import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  pollUntil,
  quoteIdent,
  runCli,
  runCliWithRetry,
  startCli,
} from './e2e-testkit.js'

/**
 * #760: a materialized view whose query changes and whose target stays the
 * same is changed with ALTER TABLE ... MODIFY QUERY, so it keeps feeding its
 * target while the migration runs. chkit-py's
 * tests/test_mv_modify_query_e2e.py runs the same cases.
 */

const env = getLiveEnv()

interface Fixture {
  dir: string
  configPath: string
  schemaPath: string
  cliEnv: Record<string, string>
  database: string
}

describe('materialized view query change e2e (#760)', () => {
  test(
    'a query-only change keeps the view feeding its target while migrate runs',
    async () => {
      const fixture = await createFixture('mvq_live')
      const executor = createLiveExecutor(env)
      const { database } = fixture
      const writeView = (where: string) =>
        writeSchema(fixture, [
          `table(${JSON.stringify(eventsTable(database, [{ name: 'ts', type: 'DateTime' }, { name: 'kind', type: 'String' }]))})`,
          `table(${JSON.stringify(countsTable(database))})`,
          `materializedView(${JSON.stringify(countsView(database, `SELECT kind, count() AS events FROM ${database}.events${where} GROUP BY kind`))})`,
        ])
      // Replicated and Shared tables drop an insert whose block repeats an
      // earlier one (two clicks in the same second), so every insert is counted on its own.
      const insert = (kind: string) =>
        executor.command(`INSERT INTO ${quoteIdent(database)}.events SETTINGS insert_deduplicate = 0 VALUES (now(), '${kind}')`)
      try {
        await writeView('')
        await generateAndMigrate(fixture, 'init', [])
        await insert('click')
        await insert('heartbeat')

        await writeView(" WHERE kind != 'heartbeat'")
        expect(planTypes(fixture)).toEqual(['alter_materialized_view_modify_query'])
        const generate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--name', 'filter', '--json'], fixture.cliEnv)
        expect(generate.exitCode, formatTestDiagnostic('generate filter', generate)).toBe(0)

        const migrate = startCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--apply', '--json'], fixture.cliEnv)
        let finished = false
        const outcome = migrate.result.finally(() => {
          finished = true
        })
        let clicksDuringMigrate = 0
        while (!finished) {
          await insert('click')
          clicksDuringMigrate += 1
        }
        const result = await outcome
        expect(result.exitCode, formatTestDiagnostic('migrate filter', result)).toBe(0)
        expect(clicksDuringMigrate).toBeGreaterThan(0)
        await insert('click')
        await insert('heartbeat')

        const expected = { click: clicksDuringMigrate + 2, heartbeat: 1 }
        const counted = await pollUntil(() => targetCounts(executor, database), (counts) => Bun.deepEquals(counts, expected))
        expect(counted).toEqual(expected)
        expectNoDrift(fixture)
      } finally {
        await cleanup(fixture, executor)
      }
    },
    240_000
  )

  test(
    'a new query that reads an added column and stops reading a dropped one migrates in place',
    async () => {
      const fixture = await createFixture('mvq_cols')
      const executor = createLiveExecutor(env)
      const { database } = fixture
      try {
        await writeSchema(fixture, [
          `table(${JSON.stringify(eventsTable(database, [{ name: 'ts', type: 'DateTime' }, { name: 'legacy_kind', type: 'String' }]))})`,
          `table(${JSON.stringify(countsTable(database))})`,
          `materializedView(${JSON.stringify(countsView(database, `SELECT legacy_kind AS kind, count() AS events FROM ${database}.events GROUP BY kind`))})`,
        ])
        await generateAndMigrate(fixture, 'init', [])
        await executor.command(`INSERT INTO ${quoteIdent(database)}.events VALUES (now(), 'click')`)

        await writeSchema(fixture, [
          `table(${JSON.stringify(eventsTable(database, [{ name: 'ts', type: 'DateTime' }, { name: 'kind', type: 'LowCardinality(String)' }]))})`,
          `table(${JSON.stringify(countsTable(database))})`,
          `materializedView(${JSON.stringify(countsView(database, `SELECT kind, count() AS events FROM ${database}.events WHERE kind != 'heartbeat' GROUP BY kind`))})`,
        ])
        expect(planTypes(fixture)).toEqual([
          'alter_table_add_column',
          'alter_materialized_view_modify_query',
          'alter_table_drop_column',
        ])
        await generateAndMigrate(fixture, 'switch', ['--allow-destructive'])
        await executor.command(`INSERT INTO ${quoteIdent(database)}.events VALUES (now(), 'view'), (now(), 'heartbeat')`)

        const expected = { click: 1, view: 1 }
        const counted = await pollUntil(() => targetCounts(executor, database), (counts) => Bun.deepEquals(counts, expected))
        expect(counted).toEqual(expected)
        expectNoDrift(fixture)
      } finally {
        await cleanup(fixture, executor)
      }
    },
    240_000
  )
})

function eventsTable(database: string, columns: Array<{ name: string; type: string }>) {
  return { database, name: 'events', engine: 'MergeTree()', columns, orderBy: ['ts'] }
}

function countsTable(database: string) {
  return {
    database,
    name: 'counts',
    engine: 'SummingMergeTree()',
    columns: [
      { name: 'kind', type: 'String' },
      { name: 'events', type: 'UInt64' },
    ],
    orderBy: ['kind'],
  }
}

function countsView(database: string, as: string) {
  return { database, name: 'counts_mv', to: { database, name: 'counts' }, as }
}

async function targetCounts(executor: ReturnType<typeof createLiveExecutor>, database: string): Promise<Record<string, number>> {
  const rows = await executor.query<{ kind: string; events: string | number }>(
    `SELECT kind, sum(events) AS events FROM ${quoteIdent(database)}.counts GROUP BY kind`
  )
  return Object.fromEntries(rows.map((row) => [row.kind, Number(row.events)]))
}

async function createFixture(label: string): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const fixture: Fixture = {
    dir,
    configPath: join(dir, 'clickhouse.config.ts'),
    schemaPath: join(dir, 'schema.ts'),
    cliEnv: { CHKIT_JOURNAL_TABLE: createJournalTableName(label), XDG_CONFIG_HOME: join(dir, 'xdg'), CI: '1' },
    database: `${createPrefix(label)}db`,
  }
  const outDir = join(dir, 'chkit')
  const config = {
    schema: fixture.schemaPath,
    outDir,
    migrationsDir: join(outDir, 'migrations'),
    metaDir: join(outDir, 'meta'),
    clickhouse: {
      url: env.clickhouseUrl,
      username: env.clickhouseUser,
      password: env.clickhousePassword,
      database: env.clickhouseDatabase,
    },
  }
  await writeFile(fixture.configPath, `export default ${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return fixture
}

async function writeSchema(fixture: Fixture, definitions: string[]): Promise<void> {
  await writeFile(
    fixture.schemaPath,
    `import { schema, table, materializedView } from '${CORE_ENTRY}'\n\nexport default schema(\n  ${definitions.join(',\n  ')},\n)\n`,
    'utf8'
  )
}

async function generateAndMigrate(fixture: Fixture, name: string, migrateFlags: string[]): Promise<void> {
  const generate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--name', name, '--json'], fixture.cliEnv)
  expect(generate.exitCode, formatTestDiagnostic(`generate ${name}`, generate)).toBe(0)
  const migrate = await runCliWithRetry(fixture.dir, ['migrate', '--config', fixture.configPath, '--apply', ...migrateFlags, '--json'], {
    extraEnv: fixture.cliEnv,
  })
  expect(migrate.exitCode, formatTestDiagnostic(`migrate ${name}`, migrate)).toBe(0)
}

function planTypes(fixture: Fixture): string[] {
  const plan = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--dryrun', '--json'], fixture.cliEnv)
  expect(plan.exitCode, formatTestDiagnostic('generate --dryrun', plan)).toBe(0)
  return (JSON.parse(plan.stdout) as { operations: Array<{ type: string }> }).operations.map((op) => op.type)
}

function expectNoDrift(fixture: Fixture): void {
  const drift = runCli(fixture.dir, ['drift', '--config', fixture.configPath, '--json'], fixture.cliEnv)
  expect(drift.exitCode, formatTestDiagnostic('drift', drift)).toBe(0)
  const payload = JSON.parse(drift.stdout) as { drifted: boolean; objectDrift: unknown[]; tableDrift: unknown[] }
  expect(payload.objectDrift).toEqual([])
  expect(payload.tableDrift).toEqual([])
  expect(payload.drifted).toBe(false)
}

async function cleanup(fixture: Fixture, executor: ReturnType<typeof createLiveExecutor>): Promise<void> {
  await rm(fixture.dir, { recursive: true, force: true })
  await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(fixture.database)} SYNC`)
  await executor.command(
    `DROP TABLE IF EXISTS ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(fixture.cliEnv.CHKIT_JOURNAL_TABLE ?? '')} SYNC`
  )
  await executor.close()
}
