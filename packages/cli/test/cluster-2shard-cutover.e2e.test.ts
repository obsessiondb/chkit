import { describe, expect, test } from 'bun:test'

import { createLiveExecutor, createStatelessLiveExecutor, formatTestDiagnostic } from '../src/test/e2e-testkit.js'
import {
  cli,
  createCutoverProject,
  dropCutoverProject,
  runKeepScenario,
  runRetryScenario,
  writeSchema,
  type CutoverTarget,
} from '../src/test/cutover-scenario.js'

// Zero-downtime cutover (#202) on test/cluster/2shard (2 shards x 2 replicas,
// ClickHouse 25.3) in cluster mode: DDL runs ON CLUSTER, the copy runs on
// every shard, and writers insert into both shards during the cutover.
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

function clusterTarget(): CutoverTarget {
  const env = (url: string) => ({ clickhouseUrl: url, clickhouseUser: USER, clickhousePassword: PASSWORD, clickhouseDatabase: DATABASE })
  const admin = createLiveExecutor(env(NODES[0] as string))
  return {
    database: DATABASE,
    connection: { url: NODES[0] as string, username: USER, password: PASSWORD, database: DATABASE, cluster: CLUSTER },
    admin,
    // A shard-1 node and a shard-2 node: rows land on both shards.
    writers: [createStatelessLiveExecutor(env(NODES[0] as string)), createStatelessLiveExecutor(env(NODES[2] as string))],
    // {uuid} keeps the path stable across EXCHANGE, so drift compares equal.
    engine: "ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')",
    rowsOf: (table) => `cluster('${CLUSTER}', ${DATABASE}, ${table})`,
    readSettings: '',
    async settle(tables) {
      for (const table of tables) {
        await admin.command(`SYSTEM SYNC REPLICA ON CLUSTER '${CLUSTER}' ${DATABASE}.${table} LIGHTWEIGHT`)
      }
    },
  }
}

describe('generate --cutover on a 2-shard cluster (#202)', () => {
  test('keeps every row on both shards while writers insert during the cutover', async () => {
    await runKeepScenario(clusterTarget(), 'cutover2s_keep')
  }, 900_000)

  test('resumes after a failure at every step and never replays the swap', async () => {
    await runRetryScenario(clusterTarget(), 'cutover2s_retry')
  }, 1_800_000)

  test('refuses the backfill copy with clickhouse.cluster', async () => {
    const target = clusterTarget()
    const project = await createCutoverProject(target, 'cutover2s_backfill')
    try {
      await writeSchema(target, project, ['user_id', 'id'])
      const result = cli(project, [
        'generate', '--cutover', `${DATABASE}.${project.table}=id`, '--cutover-copy', 'backfill', '--json',
      ])
      expect(result.exitCode, formatTestDiagnostic('generate --cutover-copy backfill', result)).toBe(1)
      const payload = JSON.parse(result.stdout) as { error: string; issues: Array<{ code: string; message: string }> }
      expect(payload.error).toBe('validation_failed')
      expect(payload.issues.map((issue) => issue.code)).toEqual(['cutover_unsupported'])
      expect(payload.issues[0]?.message).toContain('--cutover-copy backfill is not supported with clickhouse.cluster')
    } finally {
      await dropCutoverProject(target, project)
    }
  }, 300_000)
})
