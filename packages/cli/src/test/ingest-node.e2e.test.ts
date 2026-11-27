import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPrefix, createStatelessLiveExecutor, formatTestDiagnostic, getLiveEnv, quoteIdent, waitForRows, waitForTable } from './e2e-testkit.js'
import { spawnWithTimeout } from './spawn-cli.js'
import { WORKSPACE_ROOT } from './testkit.test'

const CHUNK_ROWS = 200_000
// ObsessionDB stores every MergeTree as SharedMergeTree and runs without
// clickhouse.cluster, so a node-local journal cannot exist there.
const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'

describe('chkit Sync through the published Node entry', () => {
  const env = getLiveEnv()
  const executor = createStatelessLiveExecutor(env)
  const prefix = createPrefix('ingest_node')
  const tableName = `${prefix}rows`
  const journalTable = `${prefix}journal`
  const clusterTable = `${prefix}cluster_rows`
  const clusterJournal = `${prefix}cluster_journal`
  const directories: string[] = []

  afterAll(async () => {
    for (const name of [tableName, journalTable, clusterTable, clusterJournal]) {
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(name)}`)
    }
    await executor.close()
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test('keeps the legacy package entry and testing subpath wired to the same runtime', () => {
    const result = spawnWithTimeout(['node', '--input-type=module', '-e', `
import assert from 'node:assert/strict'
import { ingest, createIngestPlugin } from '@chkit/plugin-ingest'
import { sync, createSyncPlugin } from '@chkit/plugin-sync'
import { createMemoryJournal as legacyJournal } from '@chkit/plugin-ingest/testing'
import { createMemoryJournal } from '@chkit/plugin-sync/testing'

assert.equal(ingest, sync)
assert.equal(createIngestPlugin, createSyncPlugin)
assert.equal(legacyJournal, createMemoryJournal)
`], { cwd: WORKSPACE_ROOT })
    expect(result.exitCode, formatTestDiagnostic('load both packages', result)).toBe(0)
  })

  test('loads a large chunk with ingest and reads the checkpoint after switching to Sync', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chkit-ingest-node-'))
    directories.push(directory)
    await symlink(join(WORKSPACE_ROOT, 'node_modules'), join(directory, 'node_modules'), 'dir')
    await executor.command(
      `CREATE TABLE ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(tableName)} (id UInt64, _chkit_batch_id String, _chkit_run_id String, _chkit_ingested_at DateTime64(6, 'UTC') DEFAULT now64(6)) ENGINE = MergeTree ORDER BY id`
    )
    await waitForTable(executor, env.clickhouseDatabase, tableName)
    const entry = join(directory, 'entry.ts')
    await writeFile(entry, `import { table } from '@chkit/core'
import { cursorState, definePipeline, defineStream, ingestionColumns } from '@chkit/plugin-ingest'

export const rows = table({
  database: ${JSON.stringify(env.clickhouseDatabase)}, name: ${JSON.stringify(tableName)},
  columns: [{ name: 'id', type: 'UInt64' }, ...ingestionColumns], engine: 'MergeTree()', orderBy: ['id'],
})
const stream = defineStream({
  id: 'node.large_chunk', destination: rows, budget: { maxChunkRows: ${CHUNK_ROWS} },
  incremental: cursorState({ id: 'node.cursor', version: 1, parse: Number }),
  async *read() { yield { rows: Array.from({ length: ${CHUNK_ROWS} }, (_, id) => ({ id })), state: ${CHUNK_ROWS} } },
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

    const result = runNodeCli(directory, configPath, 'ingest', 'run')
    expect(result.exitCode, formatTestDiagnostic('ingest run', result)).toBe(0)
    expect(result.stderr).toContain('Deprecated: chkit ingest is now chkit sync.')
    const payload = JSON.parse(result.stdout) as { ok: boolean; streams: Array<{ outcome: string; rows: number; chunks: number; error?: string }> }
    expect(payload.ok).toBe(true)
    expect(payload.streams[0]).toMatchObject({ outcome: 'succeeded', rows: CHUNK_ROWS, chunks: 1 })
    const counted = await waitForRows<{ n: string; distinct: string; minimum: string; maximum: string }>(
      executor,
      `SELECT count() AS n, uniqExact(id) AS distinct, min(id) AS minimum, max(id) AS maximum FROM ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(tableName)} SETTINGS select_sequential_consistency = 1, enable_parallel_replicas = 0`,
      (rows) => Number(rows[0]?.n) === CHUNK_ROWS
        && Number(rows[0]?.distinct) === CHUNK_ROWS
        && Number(rows[0]?.minimum) === 0
        && Number(rows[0]?.maximum) === CHUNK_ROWS - 1
    )
    expect(Number(counted[0]?.n)).toBe(CHUNK_ROWS)
    expect(Number(counted[0]?.distinct)).toBe(CHUNK_ROWS)
    expect(Number(counted[0]?.minimum)).toBe(0)
    expect(Number(counted[0]?.maximum)).toBe(CHUNK_ROWS - 1)

    const config = await readFile(configPath, 'utf8')
    await writeFile(configPath, config.replace("import { ingest } from '@chkit/plugin-ingest'", "import { sync } from '@chkit/plugin-sync'")
      .replace('plugins: [ingest(', 'plugins: [sync('))
    for (const command of [['sync', 'status'], ['plugin', 'sync', 'status'], ['plugin', 'ingest', 'status']]) {
      const status = runNodeCli(directory, configPath, ...command)
      expect(status.exitCode, formatTestDiagnostic(command.join(' '), status)).toBe(0)
      expect(JSON.parse(status.stdout)).toMatchObject({
        ok: true,
        command: 'status',
        streams: [{ streamId: 'node.large_chunk', checkpointVersion: 1, checkpoint: { state: CHUNK_ROWS } }],
      })
      if (command.includes('ingest')) {
        expect(status.stderr).toContain('Deprecated: chkit plugin ingest is now chkit plugin sync.')
      } else {
        expect(status.stderr).not.toContain('Deprecated:')
      }
    }
  }, 60_000)

  // The local stack defines a one-node cluster named `cluster` (test/infra/clickhouse.xml).
  test.skipIf(onObsessionDB)('with clickhouse.cluster, refuses a local journal before ingesting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chkit-ingest-cluster-'))
    directories.push(directory)
    await symlink(join(WORKSPACE_ROOT, 'node_modules'), join(directory, 'node_modules'), 'dir')
    await executor.command(
      `CREATE TABLE ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(clusterTable)} (id UInt64, _chkit_batch_id String, _chkit_run_id String, _chkit_ingested_at DateTime64(6, 'UTC') DEFAULT now64(6)) ENGINE = MergeTree ORDER BY id`
    )
    await waitForTable(executor, env.clickhouseDatabase, clusterTable)
    const entry = join(directory, 'entry.ts')
    await writeFile(entry, `import { table } from '@chkit/core'
import { cursorState, definePipeline, defineStream, ingestionColumns } from '@chkit/plugin-ingest'

export const rows = table({
  database: ${JSON.stringify(env.clickhouseDatabase)}, name: ${JSON.stringify(clusterTable)},
  columns: [{ name: 'id', type: 'UInt64' }, ...ingestionColumns], engine: 'MergeTree()', orderBy: ['id'],
})
const stream = defineStream({
  id: 'node.cluster', destination: rows,
  incremental: cursorState({ id: 'node.cursor', version: 1, parse: Number }),
  async *read({ selection }) {
    const after = selection ?? 0
    yield { rows: [after + 1, after + 2, after + 3].map((id) => ({ id })), state: after + 3 }
  },
})
export const pipeline = definePipeline({ id: 'node', streams: [stream] })
`)
    const config = async (name: string, cluster: string) => {
      const configPath = join(directory, name)
      await writeFile(configPath, `import { defineConfig } from '@chkit/core'
import { ingest } from '@chkit/plugin-ingest'

export default defineConfig({
  entry: ${JSON.stringify(entry)},
  plugins: [ingest({ journalTable: ${JSON.stringify(clusterJournal)} })],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL, username: process.env.CLICKHOUSE_USER, password: process.env.CLICKHOUSE_PASSWORD,
    database: process.env.CLICKHOUSE_DB,${cluster}
  },
})
`)
      return configPath
    }
    const countRows = async (name: string) => {
      const [row] = await executor.query<{ n: string }>(`SELECT count() AS n FROM ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(name)}`)
      return Number(row?.n)
    }

    const local = runNodeCli(directory, await config('local.config.ts', ''), 'ingest', 'run')
    expect(local.exitCode, formatTestDiagnostic('ingest run without a cluster', local)).toBe(0)
    const journalRows = await countRows(clusterJournal)

    const clustered = runNodeCli(directory, await config('cluster.config.ts', " cluster: 'cluster',"), 'ingest', 'run')
    expect(clustered.exitCode, formatTestDiagnostic('ingest run with clickhouse.cluster', clustered)).toBe(1)
    expect(JSON.parse(clustered.stdout)).toEqual({
      ok: false,
      command: 'run',
      error: expect.stringMatching(new RegExp(`^Ingest journal ${env.clickhouseDatabase}\\.${clusterJournal} is not replicated on cluster 'cluster': it is a local table on \\S+ \\(MergeTree\\)`)),
    })
    expect(await countRows(clusterTable)).toBe(3)
    expect(await countRows(clusterJournal)).toBe(journalRows)
  }, 60_000)

  function runNodeCli(directory: string, configPath: string, ...command: string[]) {
    return spawnWithTimeout(
      ['node', join(WORKSPACE_ROOT, 'packages/cli/dist/bin/chkit.js'), ...command, '--json', '--config', configPath],
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
  }
})
