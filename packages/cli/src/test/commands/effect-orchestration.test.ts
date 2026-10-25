import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { resolveConfig, table, type Snapshot } from '@chkit/core'

import { buildDriftPayload } from '../../commands/drift/payload.js'
import { pluginCommand } from '../../commands/plugin.js'
import { queryCommand } from '../../commands/query.js'
import type { ChxPluginCommandContext } from '../../plugins.js'
import { loadPluginRuntime } from '../../runtime/plugin-runtime/index.js'
import { resolveTableScope } from '../../runtime/table-scope.js'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

test.each([new Error('connection refused'), { reason: 'foreign rejection' }, undefined])(
  'query preserves foreign rejection identity: %p',
  async (failure) => {
    const context = await commandContext(executor({ query: async () => { throw failure } }))
    await expect(queryCommand.run(context)).rejects.toBe(failure)
  },
)

test.each([false, true])('query cleans executor failures in JSON mode %p', async (jsonMode) => {
  const failure = new Error('Syntax error: SELECT FORMAT JSON. (SYNTAX_ERROR)')
  const query = async (): Promise<never> => { throw failure }
  const context = await commandContext(executor({ query, queryJson: query }))
  context.flags = { '--json': jsonMode }
  await expect(queryCommand.run(context)).rejects.toThrow('Syntax error: SELECT. (SYNTAX_ERROR)')
})

test.serial('query uses the executor receiver and prints ordinary JSON', async () => {
  const output: string[] = []
  const print = spyOn(console, 'log').mockImplementation((line) => { output.push(String(line)) })
  cleanups.push(() => print.mockRestore())
  const db = executor({
    async queryJson() {
      expect(this).toBe(db)
      return { data: [], meta: [], rows: 0 }
    },
  })
  const context = await commandContext(db)
  context.flags = { '--json': true }
  expect(await queryCommand.run(context)).toBe(0)
  expect(output.map((line) => JSON.parse(line))).toEqual([{ data: [], meta: [], rows: 0 }])
})

test('plugin commands recover schema-loading failures before calling ordinary plugins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chkit-effect-command-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const schema = join(root, 'schema.ts')
  await writeFile(schema, 'throw new Error("schema unavailable")\n')
  const context = await commandContext(executor())
  context.config.schema = [schema]
  context.config.plugins = [{
    name: 'ordinary', enabled: true, options: {},
    plugin: {
      manifest: { name: 'ordinary', apiVersion: 1 },
      commands: [{ name: 'run', run: ({ tableScope }: ChxPluginCommandContext) => {
        expect(tableScope).toMatchObject({ enabled: true, matchCount: 0 })
        return 42
      } }],
    },
  }]
  context.pluginRuntime = await loadPluginRuntime({
    config: context.config, configPath: context.configPath, cliVersion: '1.0.0',
  })
  context.args = ['ordinary', 'run']
  context.flags = { '--table': 'app.ev*' }
  expect(await pluginCommand.run(context)).toBe(42)
})

test('drift recovers only unknown-database errors without inspecting tables', async () => {
  const failure = Object.assign(new Error('missing database'), { code: 81 })
  const snapshot = sampleSnapshot()
  const payload = await buildDriftPayload({}, '/meta', snapshot, undefined, executor({
    listSchemaObjects: async () => { throw failure },
  }))
  expect(payload).toMatchObject({
    databaseMissing: true, drifted: true, expectedCount: 1, actualCount: 0, missing: ['app.events'],
  })
  const foreignFailure = { code: 81 }
  await expect(buildDriftPayload({}, '/meta', snapshot, undefined, executor({
    listSchemaObjects: async () => { throw foreignFailure },
  }))).rejects.toBe(foreignFailure)
})

test('drift formatting runs both batches and falls back after a formatter rejection', async () => {
  const events: string[] = []
  const snapshot = sampleSnapshot()
  const db = executor({
    async listSchemaObjects() {
      events.push('objects')
      return [{ kind: 'table', database: 'app', name: 'events' }]
    },
    async listTableDetails() {
      events.push('tables')
      return [{
        database: 'app', name: 'events', engine: 'MergeTree', primaryKey: 'id', orderBy: 'id',
        columns: [{ name: 'id', type: 'UInt64' }], settings: {}, indexes: [],
        projections: [{ name: 'by_id', query: 'SELECT id' }],
      }]
    },
    async query(sql) {
      events.push(sql.includes("'SELECT ' || fragment") ? 'expressions' : 'queries')
      throw new Error('formatter unavailable')
    },
  })
  const payload = await buildDriftPayload({}, '/meta', snapshot, undefined, db)
  expect(events).toEqual(['objects', 'tables', 'expressions', 'queries'])
  expect(payload.drifted).toBe(false)
  expect(payload.tableDrift).toEqual([])
})

function sampleSnapshot(): Snapshot {
  return {
    version: 1, generatedAt: '2026-01-01T00:00:00.000Z',
    definitions: [table({
      database: 'app', name: 'events', engine: 'MergeTree',
      columns: [{ name: 'id', type: 'UInt64' }], primaryKey: ['id'], orderBy: ['id'],
      projections: [{ name: 'by_id', query: 'SELECT id' }],
    })],
  }
}

function executor(overrides: Partial<ClickHouseExecutor> = {}): ClickHouseExecutor {
  const unexpected = (): never => { throw new Error('Unexpected executor call') }
  return {
    command: unexpected, query: unexpected, insert: unexpected, listSchemaObjects: unexpected,
    listTableDetails: unexpected, submit: unexpected, queryStatus: unexpected, close: unexpected,
    ...overrides,
  }
}

async function commandContext(db: ClickHouseExecutor): Promise<ChxPluginCommandContext> {
  const config = resolveConfig({
    schema: [], outDir: '.chkit', migrationsDir: 'migrations', metaDir: '.chkit/meta', plugins: [],
    safety: { allowDestructive: false },
  })
  const configPath = '/fixture/clickhouse.config.ts'
  return {
    pluginName: 'core', config, configPath, jsonMode: false, args: ['SELECT 1'], flags: {},
    options: {}, rawOptions: {}, tableScope: resolveTableScope(undefined, []), print: () => {},
    pluginRuntime: await loadPluginRuntime({ config, configPath, cliVersion: '1.0.0' }),
    pluginContext: { executor: db, hasExecutor: true },
  }
}
