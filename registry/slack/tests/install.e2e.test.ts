import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createStatelessLiveExecutor, createPrefix, getLiveEnv, quoteIdent, waitForTable } from '@chkit/clickhouse/e2e-testkit'
import { createClickHouseDestination, definePipeline, runIngestion, selectStreams, type FetchContext, type SourceChunk } from '@chkit/plugin-ingest'
import { createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { buildRegistryCatalog } from '../../../packages/cli/src/registry/build.js'
import { formatTestDiagnostic, runCli } from '../../../packages/cli/src/test/e2e-testkit.js'
import { readRegistrySourceCatalog } from '../../../scripts/registry-catalog.js'
import { channel, fixtureDeps, parentMessage, replyMessage, standaloneMessage, user } from './fixtures.js'

describe.serial('built Slack template installed into a consumer', () => {
  const env = getLiveEnv()
  const executor = createStatelessLiveExecutor(env)
  const prefix = createPrefix('slack_registry')
  const root = resolve(import.meta.dir, '../../..')
  const temporary: string[] = []

  afterAll(async () => {
    const tables = await executor.query<{ name: string }>(
      `SELECT name FROM system.tables WHERE database = currentDatabase() AND startsWith(name, '${prefix}')`,
    )
    for (const table of tables) await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(table.name)}`)
    await executor.close()
    for (const path of temporary) await rm(path, { recursive: true, force: true })
  })

  test('installs portable tests, migrates without credentials, preserves JSON, and reconciles rereads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chkit-slack-installed-'))
    temporary.push(directory)
    const outputDir = join(directory, 'registry')
    await buildRegistryCatalog({ catalog: await readRegistrySourceCatalog(), sourceRoot: join(root, 'registry'), outputDir })
    const project = join(directory, 'project')
    await writeProject(project, root, env.clickhouseDatabase, prefix)
    const cliEnv = {
      CLICKHOUSE_URL: env.clickhouseUrl,
      CLICKHOUSE_USER: env.clickhouseUser,
      CLICKHOUSE_PASSWORD: env.clickhousePassword,
      CLICKHOUSE_DB: env.clickhouseDatabase,
      CHKIT_JOURNAL_TABLE: `${prefix}migrations`,
      SLACK_API_TOKEN: '',
    }
    const cli = (args: string[]) => runCli(project, args, cliEnv)
    for (const args of [['generate', '--name', 'existing', '--json'], ['migrate', '--apply', '--json']]) {
      const result = cli(args)
      expect(result.exitCode, formatTestDiagnostic('existing project', result)).toBe(0)
    }
    await waitForTable(executor, env.clickhouseDatabase, `${prefix}existing`)
    const existingTable = `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(`${prefix}existing`)}`
    await executor.command(`INSERT INTO ${existingTable} VALUES (7)`)
    const add = cli(['add', 'slack', '--registry', outputDir, '--with-tests', '--no-install', '--json'])
    expect(add.exitCode, formatTestDiagnostic('install', add)).toBe(0)
    expect(JSON.parse(add.stdout).template.name).toBe('slack')
    const fixtureTests = Bun.spawnSync(['bun', 'test', 'src/integrations/slack/tests/slack.test.ts'], {
      cwd: project, env: { ...process.env, SLACK_API_TOKEN: '' },
    })
    expect(fixtureTests.exitCode, fixtureTests.stderr.toString()).toBe(0)
    expect(await Bun.file(join(project, 'src/integrations/slack/tests/install.e2e.test.ts')).exists()).toBe(false)
    const configPath = join(project, 'src/integrations/slack/config.ts')
    const config = await readFile(configPath, 'utf8')
    await writeFile(configPath, config.replace("database: 'default'", `database: ${JSON.stringify(env.clickhouseDatabase)}`).replace("tablePrefix: 'slack'", `tablePrefix: '${prefix}'`))
    const list = cli(['ingest', 'list', '--tag', 'provider:slack', '--json'])
    expect(list.exitCode, formatTestDiagnostic('list without token', list)).toBe(0)
    expect(JSON.parse(list.stdout).streams).toHaveLength(3)
    const generate = cli(['generate', '--name', 'slack_fixture', '--json'])
    expect(generate.exitCode, formatTestDiagnostic('generate', generate)).toBe(0)
    const migrate = cli(['migrate', '--apply', '--json'])
    expect(migrate.exitCode, formatTestDiagnostic('migrate', migrate)).toBe(0)
    for (const resource of ['channels', 'users', 'messages']) await waitForTable(executor, env.clickhouseDatabase, `${prefix}_${resource}_raw`)

    const installed: typeof import('../index.js') = await import(pathToFileURL(join(project, 'src/integrations/slack/index.ts')).href)
    const channels: typeof import('../sources/channels.js') = await import(pathToFileURL(join(project, 'src/integrations/slack/sources/channels.ts')).href)
    const users: typeof import('../sources/users.js') = await import(pathToFileURL(join(project, 'src/integrations/slack/sources/users.ts')).href)
    const messages: typeof import('../sources/messages.js') = await import(pathToFileURL(join(project, 'src/integrations/slack/sources/messages.ts')).href)
    let revision = 1
    const defaults = fixtureDeps()
    const deps = fixtureDeps((url, init) => {
      const parent = { ...parentMessage, text: revision === 1 ? 'First observation' : 'Edited observation' }
      if (url.pathname === '/api/conversations.history') return Response.json({ ok: true, messages: [parent, standaloneMessage], response_metadata: { next_cursor: '' } })
      if (url.pathname === '/api/conversations.replies') return Response.json({ ok: true, messages: [parent, replyMessage], response_metadata: { next_cursor: '' } })
      return defaults.fetch(url.toString(), init)
    })
    const readers: Record<string, (context: FetchContext) => AsyncIterable<SourceChunk>> = {
      channels: (context) => channels.readChannels(context, deps),
      users: (context) => users.readUsers(context, deps),
      messages: (context) => messages.readMessages(context, deps),
    }
    const pipeline = definePipeline({
      ...installed.slack, retry: { retries: 0 },
      streams: installed.slack.streams.map((stream) => {
        const read = readers[stream.id.split('.').at(-1) ?? '']
        if (!read) throw new Error(`Installed fixture reader missing for ${stream.id}`)
        return { ...stream, read }
      }),
    })
    const journal = createMemoryJournal()
    for (const next of [1, 2]) {
      revision = next
      const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal, destination: createClickHouseDestination(executor) })
      expect(result.ok, JSON.stringify(result)).toBe(true)
    }
    const table = (resource: string) => `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(`${prefix}_${resource}_raw`)}`
    const rawMessages = await executor.query<{ id: string; text: string; channel_id: string }>(
      `SELECT id, JSONExtractString(toJSONString(raw), 'data', 'text') AS text, JSONExtractString(toJSONString(raw), 'channel_id') AS channel_id FROM ${table('messages')} FINAL ORDER BY id`,
    )
    expect(rawMessages).toEqual([
      { id: JSON.stringify(['slack.primary', 'messages', 'T1', 'C1', parentMessage.ts]), text: 'Edited observation', channel_id: 'C1' },
      { id: JSON.stringify(['slack.primary', 'messages', 'T1', 'C1', replyMessage.ts]), text: replyMessage.text, channel_id: 'C1' },
      { id: JSON.stringify(['slack.primary', 'messages', 'T1', 'C1', standaloneMessage.ts]), text: standaloneMessage.text, channel_id: 'C1' },
    ])
    const nested = await executor.query<{ blocks: string; files: string; reactions: string }>(
      `SELECT JSONExtractRaw(toJSONString(raw), 'data', 'blocks') AS blocks, JSONExtractRaw(toJSONString(raw), 'data', 'files') AS files, JSONExtractRaw(toJSONString(raw), 'data', 'reactions') AS reactions FROM ${table('messages')} FINAL WHERE id = '${JSON.stringify(['slack.primary', 'messages', 'T1', 'C1', parentMessage.ts])}'`,
    )
    expect(JSON.parse(nested[0]?.blocks ?? 'null')).toEqual(parentMessage.blocks)
    expect(JSON.parse(nested[0]?.files ?? 'null')).toEqual(parentMessage.files)
    expect(JSON.parse(nested[0]?.reactions ?? 'null')).toEqual(parentMessage.reactions)
    const rawUsers = await executor.query<{ id: string; value: string }>(
      `SELECT id, JSONExtractString(toJSONString(raw), 'data', 'profile', 'fields', 'custom_field', 'value') AS value FROM ${table('users')} FINAL ORDER BY id`,
    )
    expect(rawUsers.find((row) => row.id.includes(user.id))?.value).toBe('retained')
    const rawChannels = await executor.query<{ name: string }>(
      `SELECT JSONExtractString(toJSONString(raw), 'data', 'name') AS name FROM ${table('channels')} FINAL`,
    )
    expect(rawChannels).toEqual([{ name: channel.name }])
    const preserved = await executor.query<{ id: string }>(`SELECT id FROM ${existingTable}`)
    expect(Number(preserved[0]?.id)).toBe(7)

    const pipelinePath = join(project, 'src/integrations/slack/pipeline.ts')
    const content = await readFile(pipelinePath, 'utf8')
    await writeFile(pipelinePath, content.split('\n').filter((line) => !line.includes("tags: ['resource:messages']")).join('\n'))
    const narrowed = cli(['ingest', 'list', '--tag', 'provider:slack', '--json'])
    expect(narrowed.exitCode, formatTestDiagnostic('removed messages stream', narrowed)).toBe(0)
    expect(JSON.parse(narrowed.stdout).streams).toHaveLength(2)
    await waitForTable(executor, env.clickhouseDatabase, `${prefix}_messages_raw`)
  }, 120_000)
})

async function writeProject(project: string, root: string, database: string, prefix: string): Promise<void> {
  await mkdir(project, { recursive: true })
  await symlink(join(root, 'node_modules'), join(project, 'node_modules'), 'dir')
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'slack-fixture-consumer', private: true, type: 'module' }))
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
