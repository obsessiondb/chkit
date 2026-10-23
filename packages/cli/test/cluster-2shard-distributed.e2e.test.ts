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
  pollUntil,
  runCli,
  waitForColumn,
  waitForTable,
} from '../src/test/e2e-testkit.js'

// Distributed over ReplicatedMergeTree on test/cluster/2shard (2 shards x 2
// replicas, #279): chkit creates the local table and the Distributed table ON
// CLUSTER, rows inserted through the Distributed table spread over both shards,
// and adding a column to both tables leaves drift clean from either shard.
//
// Outside src/, excluded from default CI. Run after `bun run cluster:2shard:up`:
//   bun test packages/cli/test/cluster-2shard-distributed.e2e.test.ts
// Hard-fails (never skips) if unreachable.
const NODES = (
  process.env.CHKIT_CLUSTER_2S_NODES ??
  'http://localhost:8133,http://localhost:8134,http://localhost:8135,http://localhost:8136'
).split(',')
const CLUSTER = process.env.CHKIT_CLUSTER_2S ?? 'test_cluster_2s'
const USER = process.env.CLICKHOUSE_USER ?? 'default'
const PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? 'clusterpass'
const DATABASE = process.env.CLICKHOUSE_DB ?? 'default'
const ROWS = 100
// Explicit replication arguments: a bare `ReplicatedMergeTree` reads back with
// the server's default path, and ClickHouse unfolds {database}/{table} macros,
// so either would show as an engine mismatch in drift.
const localEngine = (local: string) =>
  `ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}/${local}', '{replica}')`

// NODES[0] is a shard-1 node (primary endpoint); NODES[2] is a shard-2 node.
const SHARD1_ENDPOINT = NODES[0] as string
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

function schemaFor(local: string, distributed: string, extraColumns: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'

const columns = [{ name: 'id', type: 'UInt64' }${extraColumns}]

export default schema(
  table({ database: '${DATABASE}', name: '${local}', engine: ${JSON.stringify(localEngine(local))}, columns, orderBy: ['id'] }),
  table({ database: '${DATABASE}', name: '${distributed}', engine: 'Distributed(${CLUSTER}, ${DATABASE}, ${local}, rand())', columns }),
)
`
}

describe('chkit cluster mode (ON CLUSTER) — Distributed over ReplicatedMergeTree', () => {
  test('creates, inserts across shards, adds a column to both tables, drift clean', async () => {
    const prefix = createPrefix('twoshard_dist')
    const local = `${prefix}events_local`
    const distributed = `${prefix}events`
    const journalTable = createJournalTableName('twoshard_dist')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
    const dir = await mkdtemp(join(tmpdir(), 'chkit-cluster-2s-dist-e2e-'))
    const schemaPath = join(dir, 'schema.ts')
    const configS1 = join(dir, 'clickhouse.config.ts')
    const configS2 = join(dir, 'clickhouse.shard2.ts')
    await writeFile(configS1, configFor(schemaPath, dir, SHARD1_ENDPOINT), 'utf8')
    await writeFile(configS2, configFor(schemaPath, dir, SHARD2_ENDPOINT), 'utf8')
    const executors = NODES.map(executorFor)
    const shard1 = executorFor(SHARD1_ENDPOINT)
    const shard2 = executorFor(SHARD2_ENDPOINT)

    const migrate = (name: string) => {
      const generate = runCli(dir, ['generate', '--config', configS1, '--name', name, '--json'], cliEnv)
      expect(generate.exitCode, formatTestDiagnostic(`generate ${name}`, generate)).toBe(0)
      const applied = runCli(dir, ['migrate', '--config', configS1, '--execute', '--json'], cliEnv)
      expect(applied.exitCode, formatTestDiagnostic(`migrate ${name}`, applied)).toBe(0)
    }
    const expectNoDrift = (config: string) => {
      const drift = runCli(dir, ['drift', '--config', config, '--json'], cliEnv)
      expect(drift.exitCode, formatTestDiagnostic('drift', drift)).toBe(0)
      const payload = JSON.parse(drift.stdout) as { drifted: boolean; tableDrift: unknown[] }
      expect(payload.tableDrift, formatTestDiagnostic('drift', drift)).toEqual([])
      expect(payload.drifted).toBe(false)
    }
    const count = async (executor: ReturnType<typeof executorFor>, from: string, expected: (n: number) => boolean) =>
      (await pollUntil(
        async () => Number((await executor.query<{ c: string }>(`SELECT count() AS c FROM ${from}`))[0]?.c ?? 0),
        expected,
      )) ?? 0

    try {
      // 1. Both tables are created on every node of both shards.
      await writeFile(schemaPath, schemaFor(local, distributed, ''), 'utf8')
      migrate('init')
      for (const node of executors) {
        await waitForTable(node, DATABASE, local)
        await waitForTable(node, DATABASE, distributed)
      }

      // 2. Rows inserted through the Distributed table land on both shards and
      // read back whole through the Distributed table from either shard.
      await shard1.command(
        `INSERT INTO ${DATABASE}.${distributed} SETTINGS distributed_foreground_insert = 1 SELECT number + 1 FROM numbers(${ROWS})`,
      )
      expect(await count(shard1, `${DATABASE}.${distributed}`, (n) => n === ROWS)).toBe(ROWS)
      expect(await count(shard2, `${DATABASE}.${distributed}`, (n) => n === ROWS)).toBe(ROWS)
      const onShard1 = await count(shard1, `${DATABASE}.${local}`, (n) => n > 0)
      const onShard2 = await count(shard2, `${DATABASE}.${local}`, (n) => n > 0)
      expect(onShard1).toBeGreaterThan(0)
      expect(onShard2).toBeGreaterThan(0)
      expect(onShard1 + onShard2).toBe(ROWS)
      expectNoDrift(configS1)

      // 3. Adding a column to both tables applies one ALTER per table ON CLUSTER.
      await writeFile(schemaPath, schemaFor(local, distributed, ", { name: 'country', type: 'String' }"), 'utf8')
      migrate('add_country')
      for (const node of executors) {
        await waitForColumn(node, DATABASE, local, 'country')
        await waitForColumn(node, DATABASE, distributed, 'country')
      }
      await shard2.command(
        `INSERT INTO ${DATABASE}.${distributed} (id, country) SETTINGS distributed_foreground_insert = 1 VALUES (1000, 'ES'), (1001, 'ES')`,
      )
      expect(await count(shard1, `${DATABASE}.${distributed} WHERE country = 'ES'`, (n) => n === 2)).toBe(2)
      expectNoDrift(configS1)
      expectNoDrift(configS2)
    } finally {
      await shard1.command(`DROP TABLE IF EXISTS ${DATABASE}.${distributed} ON CLUSTER '${CLUSTER}' SYNC`)
      await shard1.command(`DROP TABLE IF EXISTS ${DATABASE}.${local} ON CLUSTER '${CLUSTER}' SYNC`)
      await shard1.command(`DROP TABLE IF EXISTS ${DATABASE}.\`${journalTable}\` ON CLUSTER '${CLUSTER}' SYNC`)
      await Promise.all([...executors, shard1, shard2].map((executor) => executor.close()))
      await rm(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
