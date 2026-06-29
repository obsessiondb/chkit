import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  runCli,
  waitForColumn,
  waitForTable,
} from '../src/test/e2e-testkit.js'

// Cluster-mode e2e against a local replicated ClickHouse cluster
// (test/cluster/docker-compose.yml: 1 shard, 2 replicas, cluster `test_cluster`).
//
// Defaults match that setup; override via env for a different cluster. This file
// lives OUTSIDE src/, so the default `bun test src` suite (the managed-ObsessionDB
// CI job) never collects it. Run explicitly via `bun run test:cluster` after
// `bun run cluster:up`. It hard-fails (never skips) if the cluster is unreachable.
const NODE1 = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123'
const NODE2 = process.env.CHKIT_CLUSTER_E2E_URL2 ?? 'http://localhost:8124'
const USER = process.env.CLICKHOUSE_USER ?? 'default'
const PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? 'clusterpass'
const CLUSTER = process.env.CHKIT_CLUSTER ?? 'test_cluster'
const DATABASE = process.env.CLICKHOUSE_DB ?? 'default'

function executorFor(url: string) {
  return createLiveExecutor({
    clickhouseUrl: url,
    clickhouseUser: USER,
    clickhousePassword: PASSWORD,
    clickhouseDatabase: DATABASE,
  })
}

function renderSchema(tableName: string, withLabel: boolean): string {
  const columns = [
    "    { name: 'id', type: 'UInt64' }",
    "    { name: 'ts', type: 'DateTime' }",
    ...(withLabel ? ["    { name: 'label', type: 'String' }"] : []),
  ].join(',\n')
  return `import { schema, table } from '${CORE_ENTRY}'

export default schema(
  table({
    database: '${DATABASE}',
    name: '${tableName}',
    engine: 'ReplicatedMergeTree',
    columns: [
${columns},
    ],
    primaryKey: ['id'],
    orderBy: ['id'],
  }),
)
`
}

async function scaffold(tableName: string): Promise<{ dir: string; configPath: string; schemaPath: string; migrationsDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-cluster-e2e-'))
  const schemaPath = join(dir, 'schema.ts')
  const configPath = join(dir, 'clickhouse.config.ts')
  const migrationsDir = join(dir, 'chkit', 'migrations')
  await writeFile(schemaPath, renderSchema(tableName, false), 'utf8')
  await writeFile(
    configPath,
    `export default {
  schema: '${schemaPath}',
  outDir: '${join(dir, 'chkit')}',
  migrationsDir: '${migrationsDir}',
  metaDir: '${join(dir, 'chkit', 'meta')}',
  clickhouse: {
    url: '${NODE1}',
    username: '${USER}',
    password: '${PASSWORD}',
    database: '${DATABASE}',
    cluster: '${CLUSTER}',
  },
}
`,
    'utf8',
  )
  return { dir, configPath, schemaPath, migrationsDir }
}

async function latestMigrationSql(migrationsDir: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  const last = files.at(-1)
  expect(last).toBeTruthy()
  return readFile(join(migrationsDir, last as string), 'utf8')
}

describe('chkit cluster mode (ON CLUSTER) e2e', () => {
  const node1 = executorFor(NODE1)
  const node2 = executorFor(NODE2)

  test('fans DDL across replicas, replicates the journal, and is idempotent', async () => {
    const prefix = createPrefix('cluster')
    const tableName = `${prefix}events`
    const journalTable = createJournalTableName('cluster')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
    const { dir, configPath, schemaPath, migrationsDir } = await scaffold(tableName)

    // generate: ON CLUSTER is baked into the migration file (CREATE TABLE + DB).
    const generate = runCli(dir, ['generate', '--config', configPath, '--name', 'init', '--json'], cliEnv)
    expect(generate.exitCode, formatTestDiagnostic('generate', generate)).toBe(0)
    const createSql = await latestMigrationSql(migrationsDir)
    expect(createSql).toContain(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${tableName} ON CLUSTER '${CLUSTER}'`)
    expect(createSql).toContain(`ENGINE = ReplicatedMergeTree()`)

    // migrate: applies ON CLUSTER DDL.
    const migrate = runCli(dir, ['migrate', '--config', configPath, '--execute', '--json'], cliEnv)
    expect(migrate.exitCode, formatTestDiagnostic('migrate', migrate)).toBe(0)
    const applied = (JSON.parse(migrate.stdout) as { applied: Array<{ name: string }> }).applied
    expect(applied.length).toBe(1)
    const migrationName = applied[0]?.name as string

    // table exists on BOTH replicas.
    await waitForTable(node1, DATABASE, tableName)
    await waitForTable(node2, DATABASE, tableName)

    // journal is replicated on BOTH replicas.
    for (const node of [node1, node2]) {
      await waitForTable(node, DATABASE, journalTable)
      const rows = await node.query<{ engine: string }>(
        `SELECT engine FROM system.tables WHERE database = '${DATABASE}' AND name = '${journalTable}'`,
      )
      expect(rows[0]?.engine).toBe('ReplicatedReplacingMergeTree')
    }

    // the migration row written on node1 is visible on node2 (replicated journal).
    await node2.command(`SYSTEM SYNC REPLICA ${DATABASE}.\`${journalTable}\``)
    const journalRows = await node2.query<{ name: string }>(
      `SELECT name FROM ${DATABASE}.\`${journalTable}\` FINAL WHERE migration_completed = true`,
    )
    expect(journalRows.map((r) => r.name)).toContain(migrationName)

    // idempotent: re-running migrate applies nothing.
    const rerun = runCli(dir, ['migrate', '--config', configPath, '--execute', '--json'], cliEnv)
    expect(rerun.exitCode, formatTestDiagnostic('migrate rerun', rerun)).toBe(0)
    expect((JSON.parse(rerun.stdout) as { applied: unknown[] }).applied.length).toBe(0)

    // ALTER fans out too: add a column, generate + migrate, verify on BOTH replicas.
    await writeFile(schemaPath, renderSchema(tableName, true), 'utf8')
    const generateAlter = runCli(dir, ['generate', '--config', configPath, '--name', 'add_label', '--json'], cliEnv)
    expect(generateAlter.exitCode, formatTestDiagnostic('generate alter', generateAlter)).toBe(0)
    const alterSql = await latestMigrationSql(migrationsDir)
    expect(alterSql).toContain(`ALTER TABLE ${DATABASE}.${tableName} ON CLUSTER '${CLUSTER}' ADD COLUMN IF NOT EXISTS \`label\``)

    const migrateAlter = runCli(dir, ['migrate', '--config', configPath, '--execute', '--json'], cliEnv)
    expect(migrateAlter.exitCode, formatTestDiagnostic('migrate alter', migrateAlter)).toBe(0)
    await waitForColumn(node1, DATABASE, tableName, 'label')
    await waitForColumn(node2, DATABASE, tableName, 'label')

    // RENAME fans out, with ON CLUSTER at the END of the statement (ClickHouse
    // places it after the `name TO new_name` list, not after the source name).
    const renamedTable = `${tableName}_renamed`
    await writeFile(schemaPath, renderSchema(renamedTable, true), 'utf8')
    const generateRename = runCli(
      dir,
      ['generate', '--config', configPath, '--name', 'rename', '--rename-table', `${DATABASE}.${tableName}=${DATABASE}.${renamedTable}`, '--json'],
      cliEnv,
    )
    expect(generateRename.exitCode, formatTestDiagnostic('generate rename', generateRename)).toBe(0)
    const renameSql = await latestMigrationSql(migrationsDir)
    expect(renameSql).toContain(
      `RENAME TABLE IF EXISTS ${DATABASE}.${tableName} TO ${DATABASE}.${renamedTable} ON CLUSTER '${CLUSTER}';`,
    )
    const migrateRename = runCli(dir, ['migrate', '--config', configPath, '--execute', '--json'], cliEnv)
    expect(migrateRename.exitCode, formatTestDiagnostic('migrate rename', migrateRename)).toBe(0)
    await waitForTable(node1, DATABASE, renamedTable)
    await waitForTable(node2, DATABASE, renamedTable)

    // cleanup (also exercises DROP ... ON CLUSTER).
    await node1.command(`DROP TABLE IF EXISTS ${DATABASE}.${renamedTable} ON CLUSTER '${CLUSTER}' SYNC`)
    await node1.command(`DROP TABLE IF EXISTS ${DATABASE}.\`${journalTable}\` ON CLUSTER '${CLUSTER}' SYNC`)
  }, 60_000)

  test('rejects a pre-existing non-replicated journal when cluster mode is on', async () => {
    const journalTable = createJournalTableName('cluster_p2')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
    const tableName = `${createPrefix('cluster_p2')}events`
    const { dir, configPath } = await scaffold(tableName)

    // Simulate a project that ran chkit single-node before enabling cluster mode:
    // a plain (non-replicated) journal already exists.
    await node1.command(
      `CREATE TABLE ${DATABASE}.\`${journalTable}\` (name String, applied_at DateTime64(3, 'UTC'), checksum String, chkit_version String) ENGINE = ReplacingMergeTree(applied_at) ORDER BY name`,
    )

    const generate = runCli(dir, ['generate', '--config', configPath, '--name', 'init', '--json'], cliEnv)
    expect(generate.exitCode, formatTestDiagnostic('generate', generate)).toBe(0)

    const status = runCli(dir, ['status', '--config', configPath], cliEnv)
    expect(status.exitCode).not.toBe(0)
    expect(`${status.stdout}${status.stderr}`).toContain('non-replicated engine')

    await node1.command(`DROP TABLE IF EXISTS ${DATABASE}.\`${journalTable}\` ON CLUSTER '${CLUSTER}' SYNC`)
  }, 60_000)
})
