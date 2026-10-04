import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createStatelessLiveExecutor, createPrefix, getLiveEnv, quoteIdent, waitForTable, waitForView } from '@chkit/clickhouse/e2e-testkit'
import { createClickHouseDestination, definePipeline, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { buildRegistryCatalog } from '../../../packages/cli/src/registry/build.js'
import { CLI_VERSION } from '../../../packages/cli/src/runtime/version.js'
import { formatTestDiagnostic, runCli } from '../../../packages/cli/src/test/e2e-testkit.js'
import { readRegistrySourceCatalog } from '../../../scripts/registry-catalog.js'
import { fixtureDeps, person } from './fixtures.js'

describe.serial('built Attio template installed into a consumer', () => {
  const env = getLiveEnv()
  const executor = createStatelessLiveExecutor(env)
  const prefix = createPrefix('registry')
  const root = resolve(import.meta.dir, '../../..')
  const temporary: string[] = []

  afterAll(async () => {
    const tables = await executor.query<{ name: string; engine: string }>(
      `SELECT name, engine FROM system.tables WHERE database = currentDatabase() AND startsWith(name, '${prefix}') ORDER BY engine = 'View' DESC`,
    )
    for (const table of tables) await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(table.name)}`)
    await executor.close()
    for (const path of temporary) await rm(path, { recursive: true, force: true })
  })

  test('installs, migrates, rereads fixtures, queries optional/multivalue fields, and removes one stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chkit-attio-installed-'))
    temporary.push(directory)
    const outputDir = join(directory, 'registry')
    const catalog = await readRegistrySourceCatalog()
    // Exercise unreleased source with workspace packages; published artifacts keep their release minima.
    const workspaceCatalog = { ...catalog, items: catalog.items.map((item) => item.name === 'attio' ? {
      ...item,
      dependencies: [`@chkit/core@${CLI_VERSION}`, `@chkit/plugin-ingest@${CLI_VERSION}`],
      meta: { chkit: { ...item.meta.chkit, version: `${item.meta.chkit.version}-workspace`, chkit: CLI_VERSION, ingest: CLI_VERSION } },
    } : item) }
    await buildRegistryCatalog({ catalog: workspaceCatalog, sourceRoot: join(root, 'registry'), outputDir })
    const project = join(directory, 'project')
    await writeProject(project, root, env.clickhouseDatabase, prefix)
    const cliEnv = {
      CLICKHOUSE_URL: env.clickhouseUrl,
      CLICKHOUSE_USER: env.clickhouseUser,
      CLICKHOUSE_PASSWORD: env.clickhousePassword,
      CLICKHOUSE_DB: env.clickhouseDatabase,
      CHKIT_JOURNAL_TABLE: `${prefix}migrations`,
      ATTIO_API_TOKEN: '',
    }
    const cli = (args: string[]) => runCli(project, args, cliEnv)
    for (const args of [['generate', '--name', 'existing', '--json'], ['migrate', '--apply', '--json']]) {
      const result = cli(args)
      expect(result.exitCode, formatTestDiagnostic('existing project', result)).toBe(0)
    }
    const existingTable = `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(`${prefix}existing`)}`
    await waitForTable(executor, env.clickhouseDatabase, `${prefix}existing`)
    await executor.command(`INSERT INTO ${existingTable} VALUES (7)`)
    const add = cli(['add', 'attio', '--registry', outputDir, '--with-tests', '--no-install', '--json'])
    expect(add.exitCode, formatTestDiagnostic('install', add)).toBe(0)
    expect(JSON.parse(add.stdout).template.name).toBe('attio')
    const fixtureTests = Bun.spawnSync(['bun', 'test', 'src/integrations/attio/tests/attio.test.ts'], {
      cwd: project, env: { ...process.env, ATTIO_API_TOKEN: '' },
    })
    expect(fixtureTests.exitCode, fixtureTests.stderr.toString()).toBe(0)
    expect(await Bun.file(join(project, 'src/integrations/attio/tests/install.e2e.test.ts')).exists()).toBe(false)
    const configPath = join(project, 'src/integrations/attio/config.ts')
    const config = await readFile(configPath, 'utf8')
    await writeFile(configPath, config.replace("database: 'default'", `database: ${JSON.stringify(env.clickhouseDatabase)}`).replace("tablePrefix: 'attio'", `tablePrefix: '${prefix}'`))

    const list = cli(['ingest', 'list', '--tag', 'provider:attio', '--json'])
    expect(list.exitCode, formatTestDiagnostic('list without token', list)).toBe(0)
    expect(JSON.parse(list.stdout).streams).toHaveLength(9)
    const generate = cli(['generate', '--name', 'attio_fixture', '--json'])
    expect(generate.exitCode, formatTestDiagnostic('generate', generate)).toBe(0)
    const migrate = cli(['migrate', '--apply', '--json'])
    expect(migrate.exitCode, formatTestDiagnostic('migrate', migrate)).toBe(0)
    await waitForTable(executor, env.clickhouseDatabase, `${prefix}_records_raw`)
    await waitForView(executor, env.clickhouseDatabase, `${prefix}_people`)

    const installed: typeof import('../index.js') = await import(pathToFileURL(join(project, 'src/integrations/attio/index.ts')).href)
    const readers: typeof import('../sources/records.js') = await import(pathToFileURL(join(project, 'src/integrations/attio/sources/records.ts')).href)
    const recordStream = installed.attio.streams.find((stream) => stream.id.endsWith('.records'))
    expect(recordStream).toBeDefined()
    if (!recordStream) throw new Error('Installed records stream is missing')
    let revision = 1
    const deps = fixtureDeps((url) => {
      if (url.pathname === '/v2/objects') return Response.json({ data: [
        { id: { workspace_id: 'workspace-1', object_id: 'people' }, api_slug: 'people' },
        { id: { workspace_id: 'workspace-1', object_id: 'custom' }, api_slug: 'subscriptions' },
      ] })
      if (url.pathname === '/v2/objects/people/records/query') return Response.json({ data: [
        { ...person, id: { ...person.id, object_id: 'people' }, values: { ...person.values, name: [{ full_name: revision === 1 ? 'Ada Example' : 'Ada Updated' }], email_addresses: [{ email_address: 'one@example.test' }, { email_address: 'two@example.test' }] } },
        { id: { ...person.id, object_id: 'people', record_id: 'empty-attributes' }, values: {} },
      ] })
      if (url.pathname === '/v2/objects/custom/records/query') return Response.json({ data: [{ id: { workspace_id: 'workspace-1', object_id: 'custom', record_id: 'custom-1' }, values: { unmodeled: [{ value: 'retained' }] } }] })
      throw new Error(`Unexpected provider fixture request: ${url.pathname}`)
    })
    const pipeline = definePipeline({ id: 'fixture', streams: [{ ...recordStream, read: (context) => readers.readRecords(context, deps) }], retry: { retries: 0 } })
    const journal = createMemoryJournal()
    for (const next of [1, 2]) {
      revision = next
      const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal, destination: createClickHouseDestination(executor) })
      expect(result.ok, JSON.stringify(result)).toBe(true)
    }
    const people = await executor.query<{ record_id: string; name: string; email_addresses: string[]; company_record_ids: string[] }>(
      `SELECT record_id, name, email_addresses, company_record_ids FROM ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(`${prefix}_people`)} ORDER BY record_id`,
    )
    expect(people).toEqual([
      { record_id: 'empty-attributes', name: '', email_addresses: [], company_record_ids: [] },
      { record_id: 'record-1', name: 'Ada Updated', email_addresses: ['one@example.test', 'two@example.test'], company_record_ids: [] },
    ])
    for (const resource of ['companies', 'deals']) {
      const rows = await executor.query(`SELECT * FROM ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(`${prefix}_${resource}`)}`)
      expect(rows).toEqual([])
    }
    const raw = await executor.query<{ count: string }>(`SELECT count() AS count FROM ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(`${prefix}_records_raw`)} FINAL`)
    expect(Number(raw[0]?.count)).toBe(3)
    const preserved = await executor.query<{ id: string }>(`SELECT id FROM ${existingTable}`)
    expect(Number(preserved[0]?.id)).toBe(7)
    const custom = await executor.query<{ value: string }>(`SELECT JSONExtractString(toJSONString(raw), 'data', 'values', 'unmodeled', 1, 'value') AS value FROM ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(`${prefix}_records_raw`)} FINAL WHERE JSONExtractString(toJSONString(raw), 'object_slug') = 'subscriptions'`)
    expect(custom).toEqual([{ value: 'retained' }])
    const pipelinePath = join(project, 'src/integrations/attio/pipeline.ts')
    const pipelineContent = await readFile(pipelinePath, 'utf8')
    await writeFile(pipelinePath, pipelineContent.split('\n').filter((line) => !line.includes("tags: ['resource:notes']")).join('\n'))
    const narrowed = cli(['ingest', 'list', '--json'])
    expect(narrowed.exitCode, formatTestDiagnostic('removed notes', narrowed)).toBe(0)
    expect(JSON.parse(narrowed.stdout).streams).toHaveLength(8)
    await waitForTable(executor, env.clickhouseDatabase, `${prefix}_notes_raw`)
  }, 120_000)
})

async function writeProject(project: string, root: string, database: string, prefix: string): Promise<void> {
  await mkdir(project, { recursive: true })
  await symlink(join(root, 'node_modules'), join(project, 'node_modules'), 'dir')
  await mkdir(join(project, 'src/db/schema'), { recursive: true })
  await writeFile(join(project, 'src/db/schema/existing.ts'), `import { table } from '@chkit/core'
export const existing = table({ database: ${JSON.stringify(database)}, name: '${prefix}existing', engine: 'MergeTree', columns: [{ name: 'id', type: 'UInt64' }], orderBy: ['id'] })\n`)
  await writeFile(join(project, 'clickhouse.config.ts'), `import { defineConfig } from '@chkit/core'
export default defineConfig({ schema: './src/db/schema/**/*.ts', clickhouse: {
  url: process.env.CLICKHOUSE_URL || (process.env.CLICKHOUSE_HOST ? 'https://' + process.env.CLICKHOUSE_HOST : undefined),
  username: process.env.CLICKHOUSE_USER ?? 'default', password: process.env.CLICKHOUSE_PASSWORD,
  database: ${JSON.stringify(database)},
} })\n`)
}
