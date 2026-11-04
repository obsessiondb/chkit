import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor, IntrospectedTable } from '@chkit/clickhouse'

import { createPullPlugin, PullSchema } from './index.js'

// pull leaves out what chkit and the server add, so pull then generate plans
// nothing (#466).

function introspected(name: string, engine: string, settings: Record<string, string>): IntrospectedTable {
  return {
    database: 'app',
    name,
    engine,
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
    query: async <T>(sql: string): Promise<T[]> => {
      if (!sql.includes('system.merge_tree_settings')) return []
      const rows = [
        { name: 'index_granularity', value: '8192' },
        { name: 'storage_policy', value: 'default' },
      ]
      return rows as T[]
    },
  }
  return executor as ClickHouseExecutor
}

async function pullContent(tables: IntrospectedTable[]): Promise<{ content: string; definitionCount: number; skippedObjects: unknown[] }> {
  const command = createPullPlugin().commands[0]
  if (!command) throw new Error('missing command')
  const logs: unknown[] = []
  const code = await command.run({
    args: [],
    flags: { '--dryrun': true, '--database': ['app'] },
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
  return logs[0] as { content: string; definitionCount: number; skippedObjects: unknown[] }
}

describe('@chkit/plugin-pull round trip', () => {
  test('leaves out the settings the server fills in', async () => {
    const { content } = await pullContent([
      introspected('local_t', 'MergeTree', { index_granularity: '8192', merge_with_ttl_timeout: '3600' }),
      introspected('shared_t', 'SharedMergeTree', { storage_policy: "'s3'", index_granularity: '4096' }),
      introspected('plain_s3', 'MergeTree', { storage_policy: "'s3'" }),
    ])
    const block = (name: string) => content.slice(content.indexOf(`name: "${name}"`), content.indexOf('})', content.indexOf(`name: "${name}"`)))
    expect(block('local_t')).toContain('merge_with_ttl_timeout: "3600"')
    expect(block('local_t')).not.toContain('index_granularity')
    expect(block('shared_t')).toContain('index_granularity: "4096"')
    expect(block('shared_t')).not.toContain('storage_policy')
    // storage_policy 's3' is only implied on a Shared table.
    expect(block('plain_s3')).toContain(`storage_policy: "'s3'"`)
  })

  test('leaves out the journal table, by default and when CHKIT_JOURNAL_TABLE names it', async () => {
    const previous = process.env.CHKIT_JOURNAL_TABLE
    const tables = [
      introspected('events', 'MergeTree', {}),
      introspected('_chkit_migrations', 'ReplacingMergeTree(applied_at)', {}),
      introspected('app_journal', 'ReplacingMergeTree(applied_at)', {}),
    ]
    try {
      delete process.env.CHKIT_JOURNAL_TABLE
      const byDefault = await pullContent(tables)
      expect(byDefault.content).not.toContain('"_chkit_migrations"')
      expect(byDefault.content).toContain('"app_journal"')
      expect(byDefault.definitionCount).toBe(2)
      expect(byDefault.skippedObjects).toEqual([])

      process.env.CHKIT_JOURNAL_TABLE = 'app_journal'
      const configured = await pullContent(tables)
      expect(configured.content).not.toContain('"app_journal"')
      expect(configured.content).toContain('"_chkit_migrations"')
      expect(configured.skippedObjects).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.CHKIT_JOURNAL_TABLE
      else process.env.CHKIT_JOURNAL_TABLE = previous
    }
  })
})
