import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ClickHouseExecutor, createClickHouseExecutor } from '@chkit/clickhouse'

import { executeBackfill, type BackfillChunkState } from '../../plugin-backfill/src/async-backfill.js'
import { applyAsyncStatement, makeDeterministicQueryId } from '../src/commands/migrate/async-apply.js'
import type { JournalStore, MigrationRowState } from '../src/runtime/journal-store.js'
import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  pollUntil,
  runCli,
  waitForTable,
} from '../src/test/e2e-testkit.js'
import {
  FINAL_COLUMNS,
  columnsOnEveryReplica,
  writeScenarioMigrations,
  type ScenarioTarget,
} from '../src/test/consecutive-alters-scenario.js'
import { BACKFILL_PLUGIN_ENTRY } from '../src/test/testkit.test'

// MULTI-SHARD cluster-mode e2e against test/cluster/2shard (2 shards x 2 replicas,
// replicas named per-shard so the journal's replica id must be unique cluster-wide).
//
// This is the topology that exposes a no-`{shard}` journal path: with bare
// `{replica}` the journal CREATE collides (REPLICA_ALREADY_EXISTS) on the second
// shard; chkit uses `{shard}_{replica}` so one consistent journal spans all shards.
//
// Outside src/, excluded from default CI. Run via `bun run test:cluster:2shard`
// after `bun run cluster:2shard:up`. Hard-fails (never skips) if unreachable.
const NODES = (
  process.env.CHKIT_CLUSTER_2S_NODES ??
  'http://localhost:8133,http://localhost:8134,http://localhost:8135,http://localhost:8136'
).split(',')
const CLUSTER = process.env.CHKIT_CLUSTER_2S ?? 'test_cluster_2s'
const USER = process.env.CLICKHOUSE_USER ?? 'default'
const PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? 'clusterpass'
const DATABASE = process.env.CLICKHOUSE_DB ?? 'default'

// NODES[0] is a shard-1 node (primary endpoint); NODES[1] is the other shard-1
// replica; NODES[2] is a shard-2 node.
const SHARD1_ENDPOINT = NODES[0] as string
const SHARD1_OTHER_REPLICA = NODES[1] as string
const SHARD2_ENDPOINT = NODES[2] as string

function executorFor(url: string) {
  return createLiveExecutor({ clickhouseUrl: url, clickhouseUser: USER, clickhousePassword: PASSWORD, clickhouseDatabase: DATABASE })
}

function configFor(schemaPath: string, dir: string, url: string): string {
  return `export default {
  schema: '${schemaPath}',
  outDir: '${join(dir, 'chkit')}',
  migrationsDir: '${join(dir, 'chkit', 'migrations')}',
  metaDir: '${join(dir, 'chkit', 'meta')}',
  clickhouse: { url: '${url}', username: '${USER}', password: '${PASSWORD}', database: '${DATABASE}', cluster: '${CLUSTER}' },
}
`
}

describe('chkit cluster mode (ON CLUSTER) — multi-shard journal', () => {
  test('journal forms one consistent group across all shards', async () => {
    const table = `${createPrefix('twoshard')}events`
    const journalTable = createJournalTableName('twoshard')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }

    const dir = await mkdtemp(join(tmpdir(), 'chkit-cluster-2s-e2e-'))
    const schemaPath = join(dir, 'schema.ts')
    const configS1 = join(dir, 'clickhouse.config.ts')
    const configS2 = join(dir, 'clickhouse.shard2.ts')
    await writeFile(
      schemaPath,
      `import { schema, table } from '${CORE_ENTRY}'\n\nexport default schema(table({\n  database: '${DATABASE}', name: '${table}', engine: 'ReplicatedMergeTree',\n  columns: [{ name: 'id', type: 'UInt64' }], primaryKey: ['id'], orderBy: ['id'],\n}))\n`,
      'utf8',
    )
    await writeFile(configS1, configFor(schemaPath, dir, SHARD1_ENDPOINT), 'utf8')
    await writeFile(configS2, configFor(schemaPath, dir, SHARD2_ENDPOINT), 'utf8')

    const generate = runCli(dir, ['generate', '--config', configS1, '--name', 'init', '--json'], cliEnv)
    expect(generate.exitCode, formatTestDiagnostic('generate', generate)).toBe(0)
    const migrate = runCli(dir, ['migrate', '--config', configS1, '--execute', '--json'], cliEnv)
    expect(migrate.exitCode, formatTestDiagnostic('migrate', migrate)).toBe(0)

    // The journal (replicated) and the table must exist on EVERY node across BOTH
    // shards — with bare `{replica}` the journal would be missing on shard-1 nodes.
    const executors = NODES.map(executorFor)
    for (const node of executors) {
      await waitForTable(node, DATABASE, journalTable)
      await waitForTable(node, DATABASE, table)
      const rows = await node.query<{ engine: string }>(
        `SELECT engine FROM system.tables WHERE database = '${DATABASE}' AND name = '${journalTable}'`,
      )
      expect(rows[0]?.engine).toBe('ReplicatedReplacingMergeTree')
    }

    // Cross-shard: chkit run against a shard-2 endpoint sees the journal written
    // through the shard-1 endpoint — nothing pending.
    const planOnShard2 = runCli(dir, ['migrate', '--config', configS2, '--json'], cliEnv)
    expect(planOnShard2.exitCode, formatTestDiagnostic('plan on shard2', planOnShard2)).toBe(0)
    expect((JSON.parse(planOnShard2.stdout) as { pending: string[] }).pending).toEqual([])

    const cleanup = executors[0] as ReturnType<typeof executorFor>
    await cleanup.command(`DROP TABLE IF EXISTS ${DATABASE}.${table} ON CLUSTER '${CLUSTER}' SYNC`)
    await cleanup.command(`DROP TABLE IF EXISTS ${DATABASE}.\`${journalTable}\` ON CLUSTER '${CLUSTER}' SYNC`)
  }, 90_000)

  test('dependent ALTERs on one column leave every node of both shards on the final schema (#240)', async () => {
    const target: ScenarioTarget = {
      database: DATABASE,
      table: `${createPrefix('twoshard_alters')}t`,
      engine: 'ReplicatedMergeTree',
      cluster: CLUSTER,
    }
    const journalTable = createJournalTableName('twoshard_alters')
    const dir = await mkdtemp(join(tmpdir(), 'chkit-cluster-2s-alters-e2e-'))
    const configPath = join(dir, 'clickhouse.config.ts')
    await writeScenarioMigrations(join(dir, 'chkit', 'migrations'), target)
    await writeFile(configPath, configFor(join(dir, 'schema.ts'), dir, SHARD1_ENDPOINT), 'utf8')
    const executor = executorFor(SHARD1_ENDPOINT)

    const migrate = runCli(dir, ['migrate', '--config', configPath, '--apply', '--json'], { CHKIT_JOURNAL_TABLE: journalTable })
    expect(migrate.exitCode, formatTestDiagnostic('migrate --apply', migrate)).toBe(0)

    const { replicas, hosts } = await columnsOnEveryReplica(executor, target)
    expect(replicas).toBe(NODES.length)
    expect(hosts).toHaveLength(replicas)
    for (const host of hosts) expect(host.columns).toEqual(FINAL_COLUMNS)

    await executor.command(`DROP TABLE IF EXISTS ${DATABASE}.${target.table} ON CLUSTER '${CLUSTER}' SYNC`)
    await executor.command(`DROP TABLE IF EXISTS ${DATABASE}.\`${journalTable}\` ON CLUSTER '${CLUSTER}' SYNC`)
    await executor.close()
  }, 120_000)

  // #278 on ClickHouse 25.3: the vector index takes no dimensions argument and is
  // still experimental, so the connection enables it through a URL setting (the
  // documented opt-in); chkit itself sets no experimental setting.
  test('vector index and constraints migrate ON CLUSTER and read back on every node', async () => {
    const table = `${createPrefix('twoshard_vec')}vectors`
    const journalTable = createJournalTableName('twoshard_vec')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
    const vectorUrl = (url: string) => `${url}/?clickhouse_setting_allow_experimental_vector_similarity_index=1`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-cluster-2s-vec-'))
    const schemaPath = join(dir, 'schema.ts')
    const configS1 = join(dir, 'clickhouse.config.ts')
    const configS2 = join(dir, 'clickhouse.shard2.ts')
    const writeSchema = (index: string, constraints: string) =>
      writeFile(
        schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nexport default schema(table({\n  database: '${DATABASE}', name: '${table}', engine: \"ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')\",\n  columns: [{ name: 'id', type: 'UInt64' }, { name: 's', type: 'String' }, { name: 'embedding', type: 'Array(Float32)' }],\n  primaryKey: ['id'], orderBy: ['id'],\n  indexes: [${index}],\n  constraints: [${constraints}],\n}))\n`,
        'utf8',
      )
    const run = (label: string, args: string[]) => {
      const result = runCli(dir, args, cliEnv)
      expect(result.exitCode, formatTestDiagnostic(label, result)).toBe(0)
      return JSON.parse(result.stdout)
    }
    const executors = NODES.map(executorFor)
    const createQueries = async () =>
      Promise.all(executors.map(async (node) => (await node.query<{ q: string }>(
        `SELECT create_table_query AS q FROM system.tables WHERE database = '${DATABASE}' AND name = '${table}'`,
      ))[0]?.q ?? ''))

    await writeSchema(
      "{ name: 'e', expression: 'embedding', type: 'vector_similarity', method: 'hnsw', distanceFunction: 'L2Distance' }",
      "{ name: 'allowed', check: \"s IN ('a','b') AND (id+1)*2 > 0\" }, { name: 'positive-id', assume: 'id > 0' }",
    )
    await writeFile(configS1, configFor(schemaPath, dir, vectorUrl(SHARD1_ENDPOINT)), 'utf8')
    await writeFile(configS2, configFor(schemaPath, dir, vectorUrl(SHARD2_ENDPOINT)), 'utf8')

    try {
      run('generate init', ['generate', '--config', configS1, '--name', 'init', '--json'])
      run('migrate init', ['migrate', '--config', configS1, '--execute', '--json'])
      for (const node of executors) await waitForTable(node, DATABASE, table)
      for (const query of await createQueries()) {
        expect(query).toContain("TYPE vector_similarity('hnsw', 'L2Distance')")
        expect(query).toContain("CONSTRAINT allowed CHECK (s IN ('a', 'b')) AND (((id + 1) * 2) > 0)")
        expect(query).toContain('CONSTRAINT `positive-id` ASSUME id > 0')
      }
      const drift = run('drift shard2', ['drift', '--table', `${DATABASE}.${table}`, '--config', configS2, '--json'])
      expect(drift.drifted, JSON.stringify(drift.tableDrift)).toBe(false)

      // Change the index tuning and the CHECK, drop the ASSUME.
      await writeSchema(
        "{ name: 'e', expression: 'embedding', type: 'vector_similarity', method: 'hnsw', distanceFunction: 'cosineDistance', quantization: 'f32', hnswMaxConnectionsPerLayer: 16, hnswCandidateListSizeForConstruction: 64 }",
        "{ name: 'allowed', check: \"s IN ('a','b','c')\" }",
      )
      const plan = run('generate plan', ['generate', '--config', configS1, '--dryrun', '--json'])
      expect(plan.operations.map((op: { sql: string }) => op.sql)).toEqual([
        `ALTER TABLE ${DATABASE}.${table} ON CLUSTER '${CLUSTER}' DROP CONSTRAINT IF EXISTS \`allowed\`;`,
        `ALTER TABLE ${DATABASE}.${table} ON CLUSTER '${CLUSTER}' DROP CONSTRAINT IF EXISTS \`positive-id\`;`,
        `ALTER TABLE ${DATABASE}.${table} ON CLUSTER '${CLUSTER}' DROP INDEX IF EXISTS \`e\`;`,
        `ALTER TABLE ${DATABASE}.${table} ON CLUSTER '${CLUSTER}' ADD CONSTRAINT IF NOT EXISTS \`allowed\` CHECK s IN ('a','b','c');`,
        `ALTER TABLE ${DATABASE}.${table} ON CLUSTER '${CLUSTER}' ADD INDEX IF NOT EXISTS \`e\` (embedding) TYPE vector_similarity('hnsw', 'cosineDistance', 'f32', 16, 64) GRANULARITY 100000000;`,
      ])
      run('generate change', ['generate', '--config', configS1, '--name', 'change', '--json'])
      run('migrate change', ['migrate', '--config', configS1, '--execute', '--json'])
      for (const query of await createQueries()) {
        expect(query).toContain("TYPE vector_similarity('hnsw', 'cosineDistance', 'f32', 16, 64)")
        expect(query).toContain("CONSTRAINT allowed CHECK s IN ('a', 'b', 'c')")
        expect(query).not.toContain('positive-id')
      }
      const driftAfter = run('drift shard2 after change', ['drift', '--table', `${DATABASE}.${table}`, '--config', configS2, '--json'])
      expect(driftAfter.drifted, JSON.stringify(driftAfter.tableDrift)).toBe(false)
      // The CHECK is enforced on a shard-2 replica.
      await expect(
        (executors[3] as ReturnType<typeof executorFor>).command(
          `INSERT INTO ${DATABASE}.${table} VALUES (1, 'z', [0.1, 0.2])`,
        ),
      ).rejects.toThrow(/allowed/)
    } finally {
      const cleanup = executors[0] as ReturnType<typeof executorFor>
      await cleanup.command(`DROP TABLE IF EXISTS ${DATABASE}.${table} ON CLUSTER '${CLUSTER}' SYNC`)
      await cleanup.command(`DROP TABLE IF EXISTS ${DATABASE}.\`${journalTable}\` ON CLUSTER '${CLUSTER}' SYNC`)
    }
  }, 120_000)
})

describe('chkit cluster mode (ON CLUSTER) — backfill copy under a widened-asterisk profile (#243)', () => {
  test('copies ReplicatedMergeTree rows on a shard without reading MATERIALIZED/ALIAS columns', async () => {
    const table = `${createPrefix('twoshard_bf_asterisk')}events`
    const fqn = `${DATABASE}.${table}`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-cluster-2s-bf-e2e-'))
    const schemaPath = join(dir, 'schema.ts')
    const configPath = join(dir, 'clickhouse.config.ts')
    const pluginPath = join(dir, 'backfill-plugin.ts')
    const executors = NODES.map(executorFor)
    const shard1 = executors[0] as ReturnType<typeof executorFor>
    try {
      await shard1.command(`CREATE TABLE ${fqn} ON CLUSTER '${CLUSTER}' (
        id UInt64,
        event_time DateTime,
        a String,
        m String MATERIALIZED concat(a, '_m'),
        al String ALIAS concat(a, '_al'),
        d String DEFAULT 'dflt',
        b String
      ) ENGINE = ReplicatedMergeTree PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      for (const node of executors) await waitForTable(node, DATABASE, table)
      await shard1.command(`INSERT INTO ${fqn} (id, event_time, a, d, b) VALUES
        (1, '2026-01-01 12:00:00', 'x', 'custom', 'bx'),
        (2, '2026-01-02 12:00:00', 'y', 'dflt', 'by')`)

      // The profile is simulated with @clickhouse/client URL parameters, which
      // every chkit client sends with each request.
      const profiledUrl = `${SHARD1_ENDPOINT}/?ch_asterisk_include_materialized_columns=1&ch_asterisk_include_alias_columns=1`
      await writeFile(schemaPath, `import { schema } from '${CORE_ENTRY}'\n\nexport default schema()\n`, 'utf8')
      await writeFile(pluginPath, `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin()\n`, 'utf8')
      await writeFile(configPath, `import { plugin } from '${pluginPath}'\n\n${configFor(schemaPath, dir, profiledUrl).replace('\n}\n', '\n  plugins: [{ plugin }],\n}\n')}`, 'utf8')

      const plan = runCli(dir, ['plugin', 'backfill', 'plan', '--target', fqn, '--from', '2026-01-01T00:00:00.000Z', '--to', '2026-01-03T00:00:00.000Z', '--config', configPath, '--json'])
      expect(plan.exitCode, formatTestDiagnostic('backfill plan', plan)).toBe(0)
      const planned = JSON.parse(plan.stdout) as { planId: string; strategy: string }
      expect(planned.strategy).toBe('copy')
      const run = runCli(dir, ['plugin', 'backfill', 'run', '--plan-id', planned.planId, '--poll-interval', '500', '--config', configPath, '--json'])
      expect(run.exitCode, formatTestDiagnostic('backfill run', run)).toBe(0)

      // Both shard-1 replicas hold the doubled rows; shard 2 never had any.
      const expected = [
        { id: '1', a: 'x', m: 'x_m', al: 'x_al', d: 'custom', b: 'bx', copies: '2' },
        { id: '2', a: 'y', m: 'y_m', al: 'y_al', d: 'dflt', b: 'by', copies: '2' },
      ]
      for (const [index, node] of executors.entries()) {
        const rows = await pollUntil(() => node.query<Record<string, string>>(
          `SELECT toString(id) AS id, a, m, al, d, b, toString(count()) AS copies
           FROM ${fqn} GROUP BY id, a, m, al, d, b ORDER BY id`,
        ), (value) => JSON.stringify(value) === JSON.stringify(index < 2 ? expected : []))
        expect(rows, NODES[index]).toEqual(index < 2 ? expected : [])
      }
    } finally {
      await shard1.command(`DROP TABLE IF EXISTS ${fqn} ON CLUSTER '${CLUSTER}' SYNC`)
      await Promise.all(executors.map((node) => node.close()))
    }
  }, 120_000)
})

describe('chkit cluster mode (ON CLUSTER) — backfill mv_replay of a SELECT * view (#291)', () => {
  test('writes each ReplicatedMergeTree target column by name on a shard', async () => {
    const prefix = createPrefix('twoshard_bf_mv')
    const source = `${DATABASE}.${prefix}source`
    const target = `${DATABASE}.${prefix}target`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-cluster-2s-bf-mv-e2e-'))
    const schemaPath = join(dir, 'schema.ts')
    const configPath = join(dir, 'clickhouse.config.ts')
    const pluginPath = join(dir, 'backfill-plugin.ts')
    const executors = NODES.map(executorFor)
    const shard1 = executors[0] as ReturnType<typeof executorFor>
    try {
      await shard1.command(`CREATE TABLE ${source} ON CLUSTER '${CLUSTER}' (
        id UInt64, event_time DateTime, a String, m String MATERIALIZED concat(a, '_m'), b String
      ) ENGINE = ReplicatedMergeTree PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      // Reordered, one DEFAULT column computed from a replayed value, and
      // MATERIALIZED/ALIAS columns the replay must leave to the target.
      await shard1.command(`CREATE TABLE ${target} ON CLUSTER '${CLUSTER}' (
        b String, x String DEFAULT concat(a, '_xd'), a String, event_time DateTime, id UInt64,
        tm String MATERIALIZED concat(a, '_tm'), tal String ALIAS concat(b, '_al')
      ) ENGINE = ReplicatedMergeTree PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      for (const node of executors) {
        await waitForTable(node, DATABASE, `${prefix}source`)
        await waitForTable(node, DATABASE, `${prefix}target`)
      }
      await shard1.command(`INSERT INTO ${source} (id, event_time, a, b) VALUES (1, '2026-01-01 12:00:00', 'x', 'bx')`)

      const profiledUrl = `${SHARD1_ENDPOINT}/?ch_asterisk_include_materialized_columns=1&ch_asterisk_include_alias_columns=1`
      await writeFile(schemaPath, `import { materializedView, schema } from '${CORE_ENTRY}'

export default schema(materializedView({
  database: '${DATABASE}',
  name: '${prefix}mv',
  to: { database: '${DATABASE}', name: '${prefix}target' },
  as: 'SELECT * FROM ${source}',
}))
`, 'utf8')
      await writeFile(pluginPath, `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin()\n`, 'utf8')
      await writeFile(configPath, `import { plugin } from '${pluginPath}'\n\n${configFor(schemaPath, dir, profiledUrl).replace('\n}\n', '\n  plugins: [{ plugin }],\n}\n')}`, 'utf8')

      const plan = runCli(dir, ['plugin', 'backfill', 'plan', '--target', target, '--config', configPath, '--json'])
      expect(plan.exitCode, formatTestDiagnostic('backfill plan', plan)).toBe(0)
      const planned = JSON.parse(plan.stdout) as { planId: string; strategy: string }
      expect(planned.strategy).toBe('mv_replay')
      const run = runCli(dir, ['plugin', 'backfill', 'run', '--plan-id', planned.planId, '--poll-interval', '500', '--config', configPath, '--json'])
      expect(run.exitCode, formatTestDiagnostic('backfill run', run)).toBe(0)
      expect((JSON.parse(run.stdout) as { status: string }).status).toBe('completed')

      // Both shard-1 replicas hold the replayed row; shard 2 never had any.
      const expected = [{ id: '1', a: 'x', b: 'bx', x: 'x_xd', tm: 'x_tm', tal: 'bx_al' }]
      for (const [index, node] of executors.entries()) {
        const rows = await pollUntil(() => node.query<Record<string, string>>(
          `SELECT toString(id) AS id, a, b, x, tm, tal FROM ${target} ORDER BY id`,
        ), (value) => JSON.stringify(value) === JSON.stringify(index < 2 ? expected : []))
        expect(rows, NODES[index]).toEqual(index < 2 ? expected : [])
      }
    } finally {
      await shard1.command(`DROP TABLE IF EXISTS ${source} ON CLUSTER '${CLUSTER}' SYNC`)
      await shard1.command(`DROP TABLE IF EXISTS ${target} ON CLUSTER '${CLUSTER}' SYNC`)
      await Promise.all(executors.map((node) => node.close()))
    }
  }, 120_000)
})

// #246: an async statement runs on the node that received it. A re-run whose
// requests reach another node must still see the attempt and attach to it,
// instead of running the statement's before-retry SQL and resubmitting.
describe('chkit cluster mode (ON CLUSTER) — async statement on another node', () => {
  test('a re-run through another replica attaches to the running attempt', async () => {
    const tableName = `${createPrefix('twoshard_async')}dst`
    const table = `${DATABASE}.\`${tableName}\``
    const migrationName = `20990101000000_${tableName}.sql`
    const queryId = makeDeterministicQueryId(migrationName, 0)
    const submitter = executorFor(SHARD1_ENDPOINT)
    // The other replica of shard 1, configured like the run that re-applies.
    const otherReplica = createClickHouseExecutor({
      url: SHARD1_OTHER_REPLICA,
      username: USER,
      password: PASSWORD,
      database: DATABASE,
      cluster: CLUSTER,
    })
    try {
      await submitter.command(
        `CREATE TABLE ${table} ON CLUSTER '${CLUSTER}' (n UInt64) ENGINE = ReplicatedMergeTree ORDER BY n`,
      )
      for (const node of NODES.map(executorFor)) await waitForTable(node, DATABASE, tableName)

      // The attempt a run that lost its connection left behind: about 6 s.
      const attempt = submitter.submit(
        `INSERT INTO ${table} SELECT number + sleepEachRow(0.3) FROM numbers(20) SETTINGS max_block_size = 1`,
        queryId,
      )
      await pollUntil(
        () => submitter.query<{ n: string }>(`SELECT toString(count()) AS n FROM system.processes WHERE query_id = '${queryId}'`),
        (rows) => rows[0]?.n === '1',
        { intervalMs: 100 },
      )
      // The other replica's own system.processes does not show the attempt.
      const [local] = await otherReplica.query<{ n: string }>(
        `SELECT toString(count()) AS n FROM system.processes WHERE query_id = '${queryId}'`,
      )
      expect(local?.n).toBe('0')

      const commands: string[] = []
      const submits: string[] = []
      const db: ClickHouseExecutor = {
        ...otherReplica,
        queryStatus: (id, options) => otherReplica.queryStatus(id, options),
        query: (sql, settings) => otherReplica.query(sql, settings),
        command: async (sql) => {
          commands.push(sql)
          await otherReplica.command(sql)
        },
        submit: async (sql, id) => {
          submits.push(sql)
          return otherReplica.submit(sql, id)
        },
      }
      const journal = createMemoryJournal(startedState(migrationName, queryId, `table:${DATABASE}.${tableName}`))
      const lines: string[] = []

      const result = await applyAsyncStatement({
        db,
        journalStore: journal.store,
        sql: 'SELECT 1',
        migrationName,
        migrationChecksum: MIGRATION_CHECKSUM,
        statementIndex: 0,
        operationType: 'load_table_data',
        operationKey: `table:${DATABASE}.${tableName}`,
        beforeRetry: `TRUNCATE TABLE ${table} ON CLUSTER '${CLUSTER}'`,
        log: (line) => lines.push(line),
        pollIntervalMs: 250,
      })

      expect(result.kind).toBe('completed')
      expect(lines.some((line) => line.includes('attaching to in-flight query'))).toBe(true)
      expect(commands).toEqual([])
      expect(submits).toEqual([])
      expect(journal.statuses()).toEqual(['completed'])
      await attempt
      const [rows] = await submitter.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table}`)
      expect(rows?.n).toBe('20')
    } finally {
      await submitter.command(`DROP TABLE IF EXISTS ${table} ON CLUSTER '${CLUSTER}' SYNC`)
      await otherReplica.close()
    }
  }, 90_000)
})

// #289: a backfill chunk runs on the node that received it. A resume whose
// requests reach another node must see the chunk running and poll it, instead
// of submitting it again.
describe('chkit cluster mode (ON CLUSTER) — backfill chunk on another node', () => {
  test('a resume through another replica reports the running chunk and does not resubmit it', async () => {
    const planId = createPrefix('twoshard_bf').slice(0, -1)
    const chunkId = 'c0'
    const queryId = `backfill-${planId}-${chunkId}`
    // About 6 s.
    const chunkSql = 'SELECT sleepEachRow(0.3) FROM numbers(20) SETTINGS max_block_size = 1'
    const submitter = executorFor(SHARD1_ENDPOINT)
    // The other replica of shard 1, configured like the run that resumes.
    const otherReplica = createClickHouseExecutor({
      url: SHARD1_OTHER_REPLICA,
      username: USER,
      password: PASSWORD,
      database: DATABASE,
      cluster: CLUSTER,
    })
    try {
      const attempt = submitter.submit(chunkSql, queryId)
      await pollUntil(
        () => submitter.query<{ n: string }>(`SELECT toString(count()) AS n FROM system.processes WHERE query_id = '${queryId}'`),
        (rows) => rows[0]?.n === '1',
        { intervalMs: 100 },
      )
      // The other replica's own system.processes does not show the chunk.
      const [local] = await otherReplica.query<{ n: string }>(
        `SELECT toString(count()) AS n FROM system.processes WHERE query_id = '${queryId}'`,
      )
      expect(local?.n).toBe('0')

      const submits: string[] = []
      const snapshots: BackfillChunkState[] = []
      const db: ClickHouseExecutor = {
        ...otherReplica,
        queryStatus: (id, options) => otherReplica.queryStatus(id, options),
        query: (sql, settings) => otherReplica.query(sql, settings),
        submit: async (sql, id) => {
          submits.push(id ?? sql)
          return otherReplica.submit(sql, id)
        },
      }

      const result = await executeBackfill({
        executor: db,
        cluster: CLUSTER,
        planId,
        chunks: [{ id: chunkId }],
        buildQuery: () => chunkSql,
        pollIntervalMs: 250,
        // A run that stopped between submitting the chunk and recording it.
        resumeFrom: { [chunkId]: { status: 'pending' } },
        onProgress: (progress) => {
          const state = progress[chunkId]
          if (state) snapshots.push(state)
        },
      })

      expect(snapshots[0]).toMatchObject({ status: 'running', queryId })
      expect(submits).toEqual([])
      expect(result.progress[chunkId]?.status).toBe('done')
      await attempt
    } finally {
      await Promise.all([submitter.close(), otherReplica.close()])
    }
  }, 90_000)
})

const MIGRATION_CHECKSUM = 'c1'

function createMemoryJournal(initial: MigrationRowState | null) {
  let state = initial
  const writes: MigrationRowState[] = []
  const store: JournalStore = {
    databaseMissing: false,
    async readJournal() {
      return { version: 1, applied: [] }
    },
    async readMigrationState() {
      return state
    },
    async writeMigrationState(next) {
      writes.push(next)
      state = next
    },
    async appendEntry() {},
  }
  return { store, statuses: () => writes.map((write) => write.operations[0]?.status) }
}

// What a run that lost its connection while the statement ran leaves behind.
function startedState(migrationName: string, queryId: string, operationKey: string): MigrationRowState {
  return {
    name: migrationName,
    appliedAt: '1970-01-01 00:00:00.000',
    checksum: MIGRATION_CHECKSUM,
    chkitVersion: '',
    migrationCompleted: false,
    operations: [
      {
        operationIndex: 0,
        operationKey,
        operationType: 'load_table_data',
        queryId,
        status: 'started',
        startedAt: '2026-10-02 00:00:00.000',
        finishedAt: null,
        lastError: '',
      },
    ],
  }
}
