import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPrefix, createStatelessLiveExecutor, formatTestDiagnostic, getLiveEnv, quoteIdent, waitForRows, waitForTable } from './e2e-testkit.js'
import { spawnWithTimeout } from './spawn-cli.js'
import { WORKSPACE_ROOT } from './testkit.test'

const CHUNK_ROWS = 200_000

describe('chkit ingest run through the published Node entry', () => {
  const env = getLiveEnv()
  const executor = createStatelessLiveExecutor(env)
  const prefix = createPrefix('ingest_node')
  const tableName = `${prefix}rows`
  const journalTable = `${prefix}journal`
  const directories: string[] = []

  afterAll(async () => {
    for (const name of [tableName, journalTable]) {
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(name)}`)
    }
    await executor.close()
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test('loads a single chunk larger than Node\'s argument limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chkit-ingest-node-'))
    directories.push(directory)
    await symlink(join(WORKSPACE_ROOT, 'node_modules'), join(directory, 'node_modules'), 'dir')
    await executor.command(
      `CREATE TABLE ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(tableName)} (id UInt64, _chkit_batch_id String, _chkit_run_id String, _chkit_ingested_at DateTime64(6, 'UTC') DEFAULT now64(6)) ENGINE = MergeTree ORDER BY id`
    )
    await waitForTable(executor, env.clickhouseDatabase, tableName)
    const entry = join(directory, 'entry.ts')
    await writeFile(entry, `import { table } from '@chkit/core'
import { definePipeline, defineStream, ingestionColumns } from '@chkit/plugin-ingest'

export const rows = table({
  database: ${JSON.stringify(env.clickhouseDatabase)}, name: ${JSON.stringify(tableName)},
  columns: [{ name: 'id', type: 'UInt64' }, ...ingestionColumns], engine: 'MergeTree()', orderBy: ['id'],
})
const stream = defineStream({
  id: 'node.large_chunk', destination: rows, retry: { retries: 0 }, budget: { maxChunkRows: ${CHUNK_ROWS} },
  async *read() { yield { rows: Array.from({ length: ${CHUNK_ROWS} }, (_, id) => ({ id })) } },
})
export const pipeline = definePipeline({ id: 'node', streams: [stream] })
`)
    const configPath = join(directory, 'clickhouse.config.ts')
    await writeFile(configPath, `import { defineConfig } from '@chkit/core'
import { ingest } from '@chkit/plugin-ingest'

export default defineConfig({
  entry: ${JSON.stringify(entry)},
  plugins: [ingest({ journalTable: ${JSON.stringify(journalTable)} })],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL, username: process.env.CLICKHOUSE_USER, password: process.env.CLICKHOUSE_PASSWORD,
    database: process.env.CLICKHOUSE_DB,
  },
})
`)

    const result = spawnWithTimeout(
      ['node', join(WORKSPACE_ROOT, 'packages/cli/dist/bin/chkit.js'), 'ingest', 'run', '--json', '--config', configPath],
      {
        cwd: directory,
        env: {
          CLICKHOUSE_URL: env.clickhouseUrl,
          CLICKHOUSE_USER: env.clickhouseUser,
          CLICKHOUSE_PASSWORD: env.clickhousePassword,
          CLICKHOUSE_DB: env.clickhouseDatabase,
        },
      }
    )
    expect(result.exitCode, formatTestDiagnostic('ingest run', result)).toBe(0)
    const payload = JSON.parse(result.stdout) as { ok: boolean; streams: Array<{ outcome: string; rows: number; chunks: number; error?: string }> }
    expect(payload.ok).toBe(true)
    expect(payload.streams[0]).toMatchObject({ outcome: 'succeeded', rows: CHUNK_ROWS, chunks: 1 })
    const counted = await waitForRows<{ n: string; distinct: string; minimum: string; maximum: string }>(
      executor,
      `SELECT count() AS n, uniqExact(id) AS distinct, min(id) AS minimum, max(id) AS maximum FROM ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(tableName)}`,
      (rows) => Number(rows[0]?.n) === CHUNK_ROWS
        && Number(rows[0]?.distinct) === CHUNK_ROWS
        && Number(rows[0]?.minimum) === 0
        && Number(rows[0]?.maximum) === CHUNK_ROWS - 1
    )
    expect(Number(counted[0]?.n)).toBe(CHUNK_ROWS)
    expect(Number(counted[0]?.distinct)).toBe(CHUNK_ROWS)
    expect(Number(counted[0]?.minimum)).toBe(0)
    expect(Number(counted[0]?.maximum)).toBe(CHUNK_ROWS - 1)
  }, 60_000)
})
