import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  runCli,
  waitForTable,
} from '../src/test/e2e-testkit.js'

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
})
