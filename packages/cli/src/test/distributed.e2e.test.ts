import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
  waitForColumn,
  waitForTable,
} from './e2e-testkit.js'

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../../..')
const OBSESSIONDB_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-obsessiondb/src/index.ts')
const PULL_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-pull/src/index.ts')

// The local stack defines a one-node cluster named `cluster` (test/infra/clickhouse.xml).
const CLUSTER = 'cluster'
const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'
const env = getLiveEnv()

interface Fixture {
  dir: string
  configPath: string
  schemaPath: string
  pulledPath: string
  cliEnv: Record<string, string>
  database: string
  local: string
  distributed: string
}

/**
 * #279: a Distributed table used to render `PRIMARY KEY () ORDER BY ()`, which
 * ClickHouse rejects. On open-source ClickHouse the local table and the
 * Distributed table over it go through generate, migrate, insert, drift, pull
 * and ALTER. ObsessionDB has no shards and no Distributed grant, so there the
 * obsessiondb plugin rejects the table at generate time with a clear message.
 */
describe('Distributed tables e2e', () => {
  test(
    onObsessionDB
      ? 'obsessiondb plugin rejects a Distributed table on ObsessionDB'
      : 'Distributed table: create, insert, drift, pull, ALTER and recreate',
    async () => {
      const fixture = await createFixture()
      const executor = createLiveExecutor(env)
      try {
        if (onObsessionDB) await assertObsessionDBRejects(fixture)
        else await assertDistributedLifecycle(fixture, executor)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
        if (!onObsessionDB) await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(fixture.database)} SYNC`)
        await executor.command(
          `DROP TABLE IF EXISTS ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(fixture.cliEnv.CHKIT_JOURNAL_TABLE ?? '')} SYNC`
        )
        await executor.close()
      }
    },
    240_000
  )
})

async function assertObsessionDBRejects(fixture: Fixture): Promise<void> {
  await writeSchema(fixture, [])
  const generate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--name', 'init', '--json'], fixture.cliEnv)
  expect(generate.exitCode, formatTestDiagnostic('generate should fail', generate)).not.toBe(0)
  expect(`${generate.stdout}\n${generate.stderr}`).toContain(
    `Table ${fixture.database}.${fixture.distributed} uses the Distributed engine, which ObsessionDB does not support: ObsessionDB has no shards`
  )
}

async function assertDistributedLifecycle(
  fixture: Fixture,
  executor: ReturnType<typeof createLiveExecutor>
): Promise<void> {
  const { database, local, distributed } = fixture
  const distributedName = `${quoteIdent(database)}.${quoteIdent(distributed)}`

  // 1. Create both tables through chkit.
  await writeSchema(fixture, [])
  await generateAndMigrate(fixture, 'init')
  await waitForTable(executor, database, local)
  await waitForTable(executor, database, distributed)
  const [created] = await executor.query<{ engine_full: string; sorting_key: string }>(
    `SELECT engine_full, sorting_key FROM system.tables WHERE database = '${database}' AND name = '${distributed}'`
  )
  expect(created).toEqual({
    engine_full: `Distributed('${CLUSTER}', '${database}', '${local}', rand())`,
    sorting_key: '',
  })

  // 2. Rows inserted through the Distributed table land in the local table.
  await executor.command(
    `INSERT INTO ${distributedName} (id, ts) SETTINGS distributed_foreground_insert = 1 VALUES (1, '2026-01-01 00:00:00'), (2, '2026-01-02 00:00:00')`
  )
  expect(await countRows(executor, distributedName, 2)).toBe(2)

  // 3. Drift is clean for both tables.
  expectNoDrift(fixture)

  // 4. A pulled schema round-trips: generating from it plans nothing.
  const pulled = runCli(
    fixture.dir,
    ['pull', '--config', fixture.configPath, '--out-file', fixture.pulledPath, '--database', database, '--force', '--json'],
    fixture.cliEnv
  )
  expect(pulled.exitCode, formatTestDiagnostic('pull', pulled)).toBe(0)
  const pulledContent = await readFile(fixture.pulledPath, 'utf8')
  expect(pulledContent).toContain(`engine: "Distributed('${CLUSTER}', '${database}', '${local}', rand())"`)
  await writeFile(fixture.schemaPath, pulledContent.replace("'@chkit/core'", JSON.stringify(CORE_ENTRY)), 'utf8')
  const pulledPlan = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--dryrun', '--json'], fixture.cliEnv)
  expect(pulledPlan.exitCode, formatTestDiagnostic('generate from pulled schema', pulledPlan)).toBe(0)
  expect((JSON.parse(pulledPlan.stdout) as { operations: unknown[] }).operations).toEqual([])

  // 5. Add a column to both tables: two ALTERs, one per table.
  await writeSchema(fixture, [{ name: 'country', type: 'String' }])
  const alterPlan = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--dryrun', '--json'], fixture.cliEnv)
  expect(alterPlan.exitCode, formatTestDiagnostic('generate add column', alterPlan)).toBe(0)
  expect(
    (JSON.parse(alterPlan.stdout) as { operations: Array<{ sql: string }> }).operations.map((op) => op.sql)
  ).toEqual([
    `ALTER TABLE ${database}.${local} ADD COLUMN IF NOT EXISTS \`country\` String;`,
    `ALTER TABLE ${database}.${distributed} ADD COLUMN IF NOT EXISTS \`country\` String;`,
  ])
  await generateAndMigrate(fixture, 'add_country')
  await waitForColumn(executor, database, local, 'country')
  await waitForColumn(executor, database, distributed, 'country')
  await executor.command(
    `INSERT INTO ${distributedName} (id, ts, country) SETTINGS distributed_foreground_insert = 1 VALUES (3, '2026-01-03 00:00:00', 'ES')`
  )
  expect(await countRows(executor, `${distributedName} WHERE country = 'ES'`, 1)).toBe(1)
  expectNoDrift(fixture)

  // 6. A new sharding key recreates the Distributed table at caution risk, so
  // migrate applies it without --allow-destructive and the rows stay readable.
  await writeSchema(fixture, [{ name: 'country', type: 'String' }], 'cityHash64(id)')
  const recreate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--name', 'reshard', '--json'], fixture.cliEnv)
  expect(recreate.exitCode, formatTestDiagnostic('generate reshard', recreate)).toBe(0)
  const migrated = await runCliWithRetry(fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'], {
    extraEnv: fixture.cliEnv,
  })
  expect(migrated.exitCode, formatTestDiagnostic('migrate reshard', migrated)).toBe(0)
  const resharded = await pollUntil(
    async () =>
      (
        await executor.query<{ engine_full: string }>(
          `SELECT engine_full FROM system.tables WHERE database = '${database}' AND name = '${distributed}'`
        )
      )[0]?.engine_full,
    (engine) => engine?.includes('cityHash64') ?? false
  )
  expect(resharded).toBe(`Distributed('${CLUSTER}', '${database}', '${local}', cityHash64(id))`)
  expect(await countRows(executor, distributedName, 3)).toBe(3)
  expectNoDrift(fixture)
}

async function createFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-distributed-e2e-'))
  const prefix = createPrefix('dist')
  const fixture: Fixture = {
    dir,
    configPath: join(dir, 'clickhouse.config.ts'),
    schemaPath: join(dir, 'schema.ts'),
    pulledPath: join(dir, 'pulled.ts'),
    cliEnv: { CHKIT_JOURNAL_TABLE: createJournalTableName('dist'), XDG_CONFIG_HOME: join(dir, 'xdg') },
    // ObsessionDB users cannot create databases; the rejection never gets that far.
    database: onObsessionDB ? env.clickhouseDatabase : `${prefix}db`,
    local: `${prefix}events_local`,
    distributed: `${prefix}events`,
  }
  const outDir = join(dir, 'chkit')
  await writeFile(
    fixture.configPath,
    `import { obsessiondb } from '${OBSESSIONDB_PLUGIN_ENTRY}'
import { pull } from '${PULL_PLUGIN_ENTRY}'

export default ${JSON.stringify(
      {
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
      },
      null,
      2
    ).replace(/\n}$/, ',\n  plugins: [obsessiondb(), pull()],\n}')}
`,
    'utf8'
  )
  return fixture
}

async function writeSchema(
  fixture: Fixture,
  extraColumns: Array<{ name: string; type: string }>,
  shardingKey = 'rand()'
): Promise<void> {
  const columns = [{ name: 'id', type: 'UInt64' }, { name: 'ts', type: 'DateTime' }, ...extraColumns]
  const { database, local, distributed } = fixture
  await writeFile(
    fixture.schemaPath,
    `import { schema, table } from '${CORE_ENTRY}'

// index_granularity is spelled out, as a string, because pull writes the
// server default and reads settings back as strings.
const columns = ${JSON.stringify(columns)}

export default schema(
  table({ database: '${database}', name: '${local}', engine: 'MergeTree()', columns, orderBy: ['id'], partitionBy: 'toYYYYMM(ts)', settings: { index_granularity: '8192' } }),
  table({ database: '${database}', name: '${distributed}', engine: 'Distributed(${CLUSTER}, ${database}, ${local}, ${shardingKey})', columns }),
)
`,
    'utf8'
  )
}

async function generateAndMigrate(fixture: Fixture, name: string): Promise<void> {
  const generate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--name', name, '--json'], fixture.cliEnv)
  expect(generate.exitCode, formatTestDiagnostic(`generate ${name}`, generate)).toBe(0)
  const migrate = await runCliWithRetry(fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'], {
    extraEnv: fixture.cliEnv,
  })
  expect(migrate.exitCode, formatTestDiagnostic(`migrate ${name}`, migrate)).toBe(0)
}

function expectNoDrift(fixture: Fixture): void {
  const drift = runCli(fixture.dir, ['drift', '--config', fixture.configPath, '--json'], fixture.cliEnv)
  expect(drift.exitCode, formatTestDiagnostic('drift', drift)).toBe(0)
  const payload = JSON.parse(drift.stdout) as { drifted: boolean; tableDrift: unknown[] }
  expect(payload.tableDrift, formatTestDiagnostic('drift', drift)).toEqual([])
  expect(payload.drifted).toBe(false)
}

async function countRows(
  executor: ReturnType<typeof createLiveExecutor>,
  from: string,
  expected: number
): Promise<number> {
  const count = await pollUntil(
    async () => Number((await executor.query<{ c: string }>(`SELECT count() AS c FROM ${from}`))[0]?.c ?? 0),
    (value) => value === expected
  )
  return count ?? 0
}
