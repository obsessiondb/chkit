import { expect, test } from 'bun:test'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { resolveConfig } from '@chkit/core'
import { createPullPlugin, PullSchema, type PullPluginCommandContext } from './index.js'

test('pull keeps the host executor borrowed across successful and failed commands', async () => {
  let closes = 0
  let fail = false
  const executor: ClickHouseExecutor = {
    async command() {},
    async query<T>(): Promise<T[]> { return [] },
    async insert() {},
    async listSchemaObjects() {
      if (fail) throw new Error('custom discovery failed')
      return []
    },
    async listTableDetails() { return [] },
    async submit() { return 'query' },
    async queryStatus() { return { status: 'unknown' } },
    async close() { closes += 1 },
  }
  const command = createPullPlugin().commands[0]
  expect(command).toBeDefined()
  const output: unknown[] = []
  const input = commandContext(output)
  input.pluginContext = { executor, hasExecutor: true }
  expect(await command?.run(input)).toBe(0)
  fail = true
  expect(await command?.run(input)).toBe(1)
  expect(output[1]).toEqual({ ok: false, command: 'schema', error: 'custom discovery failed' })
  expect(closes).toBe(0)
})

test('pull config and foreign callback errors remain ordinary CLI results', async () => {
  const command = createPullPlugin({ introspect: async () => { throw new Error('provider refused') } }).commands[0]
  expect(command).toBeDefined()
  const output: unknown[] = []
  const input = commandContext(output)
  expect(await command?.run(input)).toBe(2)
  expect(output[0]).toEqual({ ok: false, command: 'schema', error: 'clickhouse config is required for a custom pull introspector' })
  input.config.clickhouse = {
    url: 'http://localhost:8123', username: 'default', password: '', database: 'default', secure: false,
  }
  expect(await command?.run(input)).toBe(1)
  expect(output[1]).toEqual({ ok: false, command: 'schema', error: 'provider refused' })
})

function commandContext(output: unknown[]): PullPluginCommandContext {
  return {
    args: [],
    flags: { '--dryrun': true },
    jsonMode: true,
    options: PullSchema.parse({ databases: ['app'] }),
    rawOptions: {},
    configPath: '/tmp/clickhouse.config.ts',
    config: resolveConfig({
      schema: ['./schema.ts'], outDir: './chkit', migrationsDir: './chkit/migrations', metaDir: './chkit/meta', plugins: [],
      safety: { allowDestructive: false },
    }),
    print(value) { output.push(value) },
  }
}
