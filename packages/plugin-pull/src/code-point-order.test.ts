import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor, IntrospectedTable } from '@chkit/clickhouse'

import { createPullPlugin, PullSchema } from './index.js'

// #703: pull sorted database names and settings with a bare sort(), which
// compares UTF-16 units and puts U+1F600 (a surrogate pair) before U+FF5E.
// chkit-py sorts by code point, which puts U+FF5E first.
const EMOJI = '\u{1F600}'
const FULLWIDTH_TILDE = '～'

function introspected(database: string, settings: Record<string, string> = {}): IntrospectedTable {
  return {
    database,
    name: 't',
    engine: 'MergeTree',
    primaryKey: 'id',
    orderBy: 'id',
    columns: [{ name: 'id', type: 'UInt64' }],
    settings,
    indexes: [],
    projections: [],
  }
}

function fakeExecutor(tables: IntrospectedTable[]): ClickHouseExecutor {
  const executor: Pick<ClickHouseExecutor, 'listSchemaObjects' | 'listTableDetails' | 'query'> = {
    listSchemaObjects: async () => tables.map((t) => ({ kind: 'table' as const, database: t.database, name: t.name })),
    listTableDetails: async () => tables,
    query: async <T>(): Promise<T[]> => [],
  }
  return executor as ClickHouseExecutor
}

async function pull(tables: IntrospectedTable[], flags: Record<string, string[]>): Promise<{ content: string; databases: string[] }> {
  const command = createPullPlugin().commands[0]
  if (!command) throw new Error('missing command')
  const logs: unknown[] = []
  const code = await command.run({
    args: [],
    flags: { '--dryrun': true, ...flags },
    jsonMode: true,
    options: PullSchema.parse({}),
    rawOptions: {},
    configPath: '/tmp/clickhouse.config.ts',
    config: {
      schema: ['./schema.ts'],
      outDir: './chkit',
      migrationsDir: './chkit/migrations',
      metaDir: './chkit/meta',
      plugins: [],
      check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
      safety: { allowDestructive: false },
    },
    pluginContext: { executor: fakeExecutor(tables), hasExecutor: true },
    print(value) {
      logs.push(value)
    },
  })
  expect(code).toBe(0)
  return logs[0] as { content: string; databases: string[] }
}

describe('@chkit/plugin-pull code-point order (#703)', () => {
  test('orders --database names by code point', async () => {
    const tables = [introspected(EMOJI), introspected(FULLWIDTH_TILDE)]
    const payload = await pull(tables, { '--database': [EMOJI, FULLWIDTH_TILDE] })
    expect(payload.databases).toEqual([FULLWIDTH_TILDE, EMOJI])
  })

  test('orders the databases found on the server by code point', async () => {
    const payload = await pull([introspected(EMOJI), introspected(FULLWIDTH_TILDE)], {})
    expect(payload.databases).toEqual([FULLWIDTH_TILDE, EMOJI])
  })

  test('renders table settings in code-point order', async () => {
    const { content } = await pull([introspected('app', { [`a${EMOJI}`]: '1', [`a${FULLWIDTH_TILDE}`]: '2' })], { '--database': ['app'] })
    expect(content.indexOf(`a${FULLWIDTH_TILDE}`)).toBeGreaterThan(-1)
    expect(content.indexOf(`a${FULLWIDTH_TILDE}`)).toBeLessThan(content.indexOf(`a${EMOJI}`))
  })
})
