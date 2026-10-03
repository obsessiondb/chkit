import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createClickHouseExecutor } from '@chkit/clickhouse'
import { getLiveEnv } from '@chkit/clickhouse/e2e-testkit'
import { runCli } from '../../packages/cli/src/test/e2e-testkit.js'

const root = resolve(import.meta.dir, '../..')
// The broker runs in the local test stack, so this suite only runs against it.
const compose = ['docker', 'compose', '-f', join(root, 'test/infra/docker-compose.yml')]
const { clickhouseUrl: url, clickhousePassword: password } = getLiveEnv()

async function broker(args: string[], stdin?: string) {
  const proc = Bun.spawn([...compose, 'exec', '-T', 'kafka', 'rpk', ...args], {
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect(exitCode, stderr).toBe(0)
}

test('Kafka → MV → MergeTree: generate, migrate, consume, pull, drift, check and explicit replacement', async () => {
  const tag = `${Date.now()}_${Math.floor(Math.random() * 100000)}`
  const database = `chkit_kafka_${tag}`
  const topic = `chkit_${tag}`
  const journal = `_chkit_kafka_${tag}`
  const dir = await mkdtemp(join(tmpdir(), 'chkit-kafka-'))
  const db = createClickHouseExecutor({ url, password, username: 'default', database: 'default' })
  const clientId = "client; COMMENT 'quoted' \\"
  const source = (
    includeQueue: boolean,
    consumers = 1,
  ) => `import { schema, table, materializedView } from '@chkit/core'
const storage = table({ database: '${database}', name: 'events', engine: 'MergeTree', columns: [{ name: 'id', type: 'UInt64' }, { name: 'body', type: 'String' }], primaryKey: ['id'], orderBy: ['id'], settings: { index_granularity: '8192' } })
${
  includeQueue
    ? `const queue = table({ database: '${database}', name: 'queue', engine: 'Kafka', columns: storage.columns, settings: { kafka_broker_list: 'kafka:9092', kafka_topic_list: '${topic}', kafka_group_name: '${topic}', kafka_format: 'JSONEachRow', kafka_client_id: ${JSON.stringify(clientId)}, kafka_num_consumers: ${consumers}, kafka_flush_interval_ms: 100, kafka_commit_on_select: false, input_format_skip_unknown_fields: true } })
const mv = materializedView({ database: '${database}', name: 'consumer', to: { database: '${database}', name: 'events' }, as: 'SELECT id, body FROM ${database}.queue' })`
    : ''
}
export default schema(storage${includeQueue ? ', queue, mv' : ''})
`
  const cli = (args: string[], success = true) => {
    const result = runCli(dir, [...args, '--config', join(dir, 'clickhouse.config.ts'), '--json'], {
      CHKIT_JOURNAL_TABLE: journal,
    })
    if (success) expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    return result
  }
  const waitForIds = async (ids: number[]) => {
    const deadline = Date.now() + 30000
    let actual: number[] = []
    do {
      actual = (
        await db.query<{ id: string }>(`SELECT id FROM ${database}.events ORDER BY id`)
      ).map((row) => Number(row.id))
      if (JSON.stringify(actual) === JSON.stringify(ids)) return
      await sleep(200)
    } while (Date.now() < deadline)
    expect(actual).toEqual(ids)
  }
  try {
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'))
    await writeFile(join(dir, 'schema.ts'), source(true))
    await writeFile(
      join(dir, 'clickhouse.config.ts'),
      `import { pull } from '@chkit/plugin-pull'
export default { schema: './schema.ts', outDir: './chkit', plugins: [pull()], clickhouse: { url: '${url}', username: 'default', password: '${password}', database: 'default' } }`,
    )
    await broker(['topic', 'create', topic, '-p', '2'])
    cli(['generate', '--name', 'create', '--migration-id', '001'])
    cli(['migrate', '--apply'])
    await broker(
      ['topic', 'produce', topic],
      '{"id":1,"body":"hello","ignored":true}\n{"id":2,"body":"world"}\n',
    )
    await waitForIds([1, 2])
    expect(JSON.parse(cli(['drift']).stdout).drifted).toBe(false)
    cli(['check'])

    // Round-trip through the actual pull command and rerun generation.
    const pulled = join(dir, 'pulled.ts')
    cli(['pull', 'schema', '--database', database, '--out-file', pulled])
    const content = await readFile(pulled, 'utf8')
    const queueBlock = content.slice(content.indexOf('name: "queue"'))
    expect(queueBlock).not.toContain('primaryKey:')
    expect(content).toContain(JSON.stringify(clientId))
    await writeFile(join(dir, 'schema.ts'), content)
    const roundTrip = cli(['generate', '--dryrun'])
    expect(JSON.parse(roundTrip.stdout).operationCount, roundTrip.stdout).toBe(0)

    // Settings drift is observable without trying unsupported Kafka ALTERs.
    const snapshotPath = join(dir, 'chkit/meta/snapshot.json')
    const snapshotText = await readFile(snapshotPath, 'utf8')
    const snapshot = JSON.parse(snapshotText)
    snapshot.definitions.find(
      (def: { name: string }) => def.name === 'queue',
    ).settings.kafka_group_name = 'different'
    await writeFile(snapshotPath, JSON.stringify(snapshot))
    expect(JSON.parse(cli(['drift'], false).stdout).tableDrift[0].settingDiffs).toContain(
      'kafka_group_name',
    )
    expect(cli(['check'], false).exitCode).not.toBe(0)
    await writeFile(snapshotPath, snapshotText)

    // A refused change must not update either snapshot or migration files.
    const beforeFiles = await readdir(join(dir, 'chkit/migrations'))
    await writeFile(join(dir, 'schema.ts'), source(true, 2))
    const blocked = cli(['generate', '--name', 'unsafe'], false)
    expect(blocked.exitCode).not.toBe(0)
    expect(blocked.stdout).toContain('kafka_change_requires_replacement')
    expect(await readFile(snapshotPath, 'utf8')).toBe(snapshotText)
    expect(await readdir(join(dir, 'chkit/migrations'))).toEqual(beforeFiles)

    // Explicit two-migration replacement keeps the storage table and snapshot.
    await writeFile(join(dir, 'schema.ts'), source(false))
    cli(['generate', '--name', 'stop-queue', '--migration-id', '002'])
    await writeFile(join(dir, 'schema.ts'), source(true, 2))
    cli(['generate', '--name', 'restart-queue', '--migration-id', '003'])
    expect(cli(['migrate', '--apply'], false).exitCode).not.toBe(0)
    cli(['migrate', '--apply', '--allow-destructive'])
    await broker(['topic', 'produce', topic], '{"id":3,"body":"after replacement"}\n')
    await waitForIds([1, 2, 3])
    cli(['check'])
  } finally {
    await db.command(`DROP DATABASE IF EXISTS ${database} SYNC`)
    await db.command(`DROP TABLE IF EXISTS default.${journal} SYNC`)
    await db.close()
    await broker(['topic', 'delete', topic])
    await rm(dir, { recursive: true, force: true })
  }
}, 120000)
