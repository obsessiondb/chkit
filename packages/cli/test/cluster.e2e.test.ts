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

function configFor(schemaPath: string, dir: string, url: string): string {
  return `export default {
  schema: '${schemaPath}',
  outDir: '${join(dir, 'chkit')}',
  migrationsDir: '${join(dir, 'chkit', 'migrations')}',
  metaDir: '${join(dir, 'chkit', 'meta')}',
  clickhouse: {
    url: '${url}',
    username: '${USER}',
    password: '${PASSWORD}',
    database: '${DATABASE}',
    cluster: '${CLUSTER}',
  },
}
`
}

interface Project {
  dir: string
  schemaPath: string
  configPath: string
  config2Path: string
  migrationsDir: string
}

async function scaffold(schema: string): Promise<Project> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-cluster-e2e-'))
  const schemaPath = join(dir, 'schema.ts')
  const configPath = join(dir, 'clickhouse.config.ts')
  const config2Path = join(dir, 'clickhouse.node2.ts')
  await writeFile(schemaPath, schema, 'utf8')
  await writeFile(configPath, configFor(schemaPath, dir, NODE1), 'utf8')
  await writeFile(config2Path, configFor(schemaPath, dir, NODE2), 'utf8')
  return { dir, schemaPath, configPath, config2Path, migrationsDir: join(dir, 'chkit', 'migrations') }
}

async function latestMigrationSql(migrationsDir: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  const last = files.at(-1)
  expect(last).toBeTruthy()
  return readFile(join(migrationsDir, last as string), 'utf8')
}

const node1 = executorFor(NODE1)
const node2 = executorFor(NODE2)

describe('chkit cluster mode (ON CLUSTER) e2e', () => {
  test('creates every object type on both replicas, replicates the journal, idempotent + cross-endpoint', async () => {
    const prefix = createPrefix('cluster')
    const events = `${prefix}events`
    const sum = `${prefix}sum`
    const vw = `${prefix}view`
    const mv = `${prefix}mv`
    const journalTable = createJournalTableName('cluster')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }

    const schema = (withLabel: boolean) => `import { schema, table, view, materializedView } from '${CORE_ENTRY}'

const events = table({
  database: '${DATABASE}', name: '${events}', engine: 'ReplicatedMergeTree',
  columns: [{ name: 'id', type: 'UInt64' }, { name: 'ts', type: 'DateTime' }${withLabel ? ", { name: 'label', type: 'String' }" : ''}],
  primaryKey: ['id'], orderBy: ['id'],
})
const sum = table({
  database: '${DATABASE}', name: '${sum}', engine: 'ReplicatedMergeTree',
  columns: [{ name: 'id', type: 'UInt64' }, { name: 'ts', type: 'DateTime' }],
  primaryKey: ['id'], orderBy: ['id'],
})
const vw = view({ database: '${DATABASE}', name: '${vw}', as: 'SELECT id FROM ${DATABASE}.${events}' })
const mv = materializedView({
  database: '${DATABASE}', name: '${mv}', to: { database: '${DATABASE}', name: '${sum}' },
  as: 'SELECT id, ts FROM ${DATABASE}.${events}',
})
export default schema(events, sum, vw, mv)
`

    const project = await scaffold(schema(false))

    // generate: ON CLUSTER baked into every CREATE.
    const generate = runCli(project.dir, ['generate', '--config', project.configPath, '--name', 'init', '--json'], cliEnv)
    expect(generate.exitCode, formatTestDiagnostic('generate', generate)).toBe(0)
    const sql = await latestMigrationSql(project.migrationsDir)
    for (const fragment of [
      `CREATE DATABASE IF NOT EXISTS ${DATABASE} ON CLUSTER '${CLUSTER}'`,
      `CREATE TABLE IF NOT EXISTS ${DATABASE}.${events} ON CLUSTER '${CLUSTER}'`,
      `CREATE TABLE IF NOT EXISTS ${DATABASE}.${sum} ON CLUSTER '${CLUSTER}'`,
      `CREATE VIEW IF NOT EXISTS ${DATABASE}.${vw} ON CLUSTER '${CLUSTER}'`,
      `CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.${mv} ON CLUSTER '${CLUSTER}'`,
    ]) {
      expect(sql).toContain(fragment)
    }

    // migrate: every object lands on BOTH replicas.
    const migrate = runCli(project.dir, ['migrate', '--config', project.configPath, '--execute', '--json'], cliEnv)
    expect(migrate.exitCode, formatTestDiagnostic('migrate', migrate)).toBe(0)
    for (const name of [events, sum, vw, mv]) {
      await waitForTable(node1, DATABASE, name)
      await waitForTable(node2, DATABASE, name)
    }

    // journal is a replicated engine on both nodes, with the row replicated.
    for (const node of [node1, node2]) {
      await waitForTable(node, DATABASE, journalTable)
      const rows = await node.query<{ engine: string }>(
        `SELECT engine FROM system.tables WHERE database = '${DATABASE}' AND name = '${journalTable}'`,
      )
      expect(rows[0]?.engine).toBe('ReplicatedReplacingMergeTree')
    }

    // cross-endpoint: chkit run against node2 sees the replicated journal — nothing pending.
    const planOnNode2 = runCli(project.dir, ['migrate', '--config', project.config2Path, '--json'], cliEnv)
    expect(planOnNode2.exitCode, formatTestDiagnostic('plan on node2', planOnNode2)).toBe(0)
    expect((JSON.parse(planOnNode2.stdout) as { pending: string[] }).pending).toEqual([])

    // idempotent: re-running migrate applies nothing.
    const rerun = runCli(project.dir, ['migrate', '--config', project.configPath, '--execute', '--json'], cliEnv)
    expect(rerun.exitCode, formatTestDiagnostic('rerun', rerun)).toBe(0)
    expect((JSON.parse(rerun.stdout) as { applied: unknown[] }).applied.length).toBe(0)

    // ALTER fans out too.
    await writeFile(project.schemaPath, schema(true), 'utf8')
    const generateAlter = runCli(project.dir, ['generate', '--config', project.configPath, '--name', 'add_label', '--json'], cliEnv)
    expect(generateAlter.exitCode, formatTestDiagnostic('generate alter', generateAlter)).toBe(0)
    expect(await latestMigrationSql(project.migrationsDir)).toContain(
      `ALTER TABLE ${DATABASE}.${events} ON CLUSTER '${CLUSTER}' ADD COLUMN IF NOT EXISTS \`label\``,
    )
    const migrateAlter = runCli(project.dir, ['migrate', '--config', project.configPath, '--execute', '--json'], cliEnv)
    expect(migrateAlter.exitCode, formatTestDiagnostic('migrate alter', migrateAlter)).toBe(0)
    await waitForColumn(node1, DATABASE, events, 'label')
    await waitForColumn(node2, DATABASE, events, 'label')

    for (const name of [mv, vw, sum, events, journalTable]) {
      await node1.command(`DROP TABLE IF EXISTS ${DATABASE}.\`${name}\` ON CLUSTER '${CLUSTER}' SYNC`)
    }
  }, 90_000)

  test('drop+recreate and rename fan out with correct ON CLUSTER placement', async () => {
    const prefix = createPrefix('cluster_ddl')
    const box = `${prefix}box`
    const renamed = `${box}_renamed`
    const journalTable = createJournalTableName('cluster_ddl')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }

    const schema = (name: string, orderBy: string) => `import { schema, table } from '${CORE_ENTRY}'

export default schema(table({
  database: '${DATABASE}', name: '${name}', engine: 'ReplicatedMergeTree',
  columns: [{ name: 'id', type: 'UInt64' }, { name: 'ts', type: 'DateTime' }],
  primaryKey: ['id'], orderBy: [${orderBy}],
}))
`
    const project = await scaffold(schema(box, "'id'"))

    const genInit = runCli(project.dir, ['generate', '--config', project.configPath, '--name', 'init', '--json'], cliEnv)
    expect(genInit.exitCode, formatTestDiagnostic('generate init', genInit)).toBe(0)
    const created = runCli(project.dir, ['migrate', '--config', project.configPath, '--execute', '--json'], cliEnv)
    expect(created.exitCode, formatTestDiagnostic('create', created)).toBe(0)
    await waitForTable(node1, DATABASE, box)
    await waitForTable(node2, DATABASE, box)

    // drop+recreate (ORDER BY change): both DROP and CREATE carry ON CLUSTER, and
    // the recreate is collision-free ({uuid} default_replica_path).
    await writeFile(project.schemaPath, schema(box, "'id', 'ts'"), 'utf8')
    const genRecreate = runCli(project.dir, ['generate', '--config', project.configPath, '--name', 'reorder', '--json'], cliEnv)
    expect(genRecreate.exitCode, formatTestDiagnostic('generate recreate', genRecreate)).toBe(0)
    const recreateSql = await latestMigrationSql(project.migrationsDir)
    expect(recreateSql).toContain(`DROP TABLE IF EXISTS ${DATABASE}.${box} ON CLUSTER '${CLUSTER}'`)
    expect(recreateSql).toContain(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${box} ON CLUSTER '${CLUSTER}'`)
    const migRecreate = runCli(project.dir, ['migrate', '--config', project.configPath, '--execute', '--allow-destructive', '--json'], cliEnv)
    expect(migRecreate.exitCode, formatTestDiagnostic('migrate recreate', migRecreate)).toBe(0)
    for (const node of [node1, node2]) {
      const rows = await node.query<{ sorting_key: string }>(
        `SELECT sorting_key FROM system.tables WHERE database = '${DATABASE}' AND name = '${box}'`,
      )
      expect(rows[0]?.sorting_key).toBe('id, ts')
    }

    // rename: ON CLUSTER must sit at the END of the statement.
    await writeFile(project.schemaPath, schema(renamed, "'id', 'ts'"), 'utf8')
    const genRename = runCli(
      project.dir,
      ['generate', '--config', project.configPath, '--name', 'rename', '--rename-table', `${DATABASE}.${box}=${DATABASE}.${renamed}`, '--json'],
      cliEnv,
    )
    expect(genRename.exitCode, formatTestDiagnostic('generate rename', genRename)).toBe(0)
    expect(await latestMigrationSql(project.migrationsDir)).toContain(
      `RENAME TABLE IF EXISTS ${DATABASE}.${box} TO ${DATABASE}.${renamed} ON CLUSTER '${CLUSTER}';`,
    )
    const migRename = runCli(project.dir, ['migrate', '--config', project.configPath, '--execute', '--json'], cliEnv)
    expect(migRename.exitCode, formatTestDiagnostic('migrate rename', migRename)).toBe(0)
    await waitForTable(node1, DATABASE, renamed)
    await waitForTable(node2, DATABASE, renamed)

    await node1.command(`DROP TABLE IF EXISTS ${DATABASE}.${renamed} ON CLUSTER '${CLUSTER}' SYNC`)
    await node1.command(`DROP TABLE IF EXISTS ${DATABASE}.\`${journalTable}\` ON CLUSTER '${CLUSTER}' SYNC`)
  }, 90_000)
})
