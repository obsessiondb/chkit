import { describe, expect, test } from 'bun:test'
import type { ResolvedChxConfig, SchemaDefinition } from '@chkit/core'

import {
  isObsessionDBHost,
  obsessiondb,
  resolveStripBehavior,
  rewriteSharedEngines,
  stripSharedPrefix,
} from './index'

function makeConfig(url?: string): ResolvedChxConfig {
  return {
    schema: ['schema/**/*.ts'],
    outDir: '.chkit',
    migrationsDir: 'migrations',
    metaDir: '.chkit/meta',
    plugins: [],
    check: { unusedTables: true, unusedColumns: true },
    safety: { allowDestructive: false },
    ...(url ? { clickhouse: { url, username: 'default', password: '', database: 'default', secure: false } } : {}),
  }
}

function makeTable(name: string, engine: string): SchemaDefinition {
  return {
    kind: 'table',
    database: 'default',
    name,
    columns: [{ name: 'id', type: 'UInt64' }],
    engine,
    primaryKey: ['id'],
    orderBy: ['id'],
  }
}

function makeView(name: string): SchemaDefinition {
  return {
    kind: 'view',
    database: 'default',
    name,
    as: 'SELECT 1',
  }
}

function makeMaterializedView(name: string): SchemaDefinition {
  return {
    kind: 'materialized_view',
    database: 'default',
    name,
    to: { database: 'default', name: 'target' },
    as: 'SELECT 1',
  }
}

describe('isObsessionDBHost', () => {
  test('matches obsessiondb.com subdomains', () => {
    expect(isObsessionDBHost('https://my-cluster.obsessiondb.com:8443')).toBe(true)
    expect(isObsessionDBHost('https://app.obsessiondb.com')).toBe(true)
    expect(isObsessionDBHost('https://obsessiondb.com')).toBe(true)
  })

  test('matches numia-dev.com hosts', () => {
    expect(isObsessionDBHost('https://obsession.numia-dev.com:8443')).toBe(true)
    expect(isObsessionDBHost('https://ch.obsession.numia-dev.com')).toBe(true)
  })

  test('does not match regular ClickHouse hosts', () => {
    expect(isObsessionDBHost('http://localhost:8123')).toBe(false)
    expect(isObsessionDBHost('https://clickhouse.example.com:8443')).toBe(false)
    expect(isObsessionDBHost('https://notobsessiondb.com')).toBe(false)
  })

  test('returns false for invalid URLs', () => {
    expect(isObsessionDBHost('not-a-url')).toBe(false)
    expect(isObsessionDBHost('')).toBe(false)
  })
})

describe('stripSharedPrefix', () => {
  test('strips Shared prefix from engine names', () => {
    expect(stripSharedPrefix('SharedReplacingMergeTree(ingested_at)')).toBe('ReplacingMergeTree(ingested_at)')
    expect(stripSharedPrefix('SharedMergeTree')).toBe('MergeTree')
    expect(stripSharedPrefix('SharedAggregatingMergeTree')).toBe('AggregatingMergeTree')
  })

  test('leaves non-Shared engines unchanged', () => {
    expect(stripSharedPrefix('MergeTree')).toBe('MergeTree')
    expect(stripSharedPrefix('ReplacingMergeTree(ts)')).toBe('ReplacingMergeTree(ts)')
    expect(stripSharedPrefix('Log')).toBe('Log')
  })
})

describe('rewriteSharedEngines', () => {
  test('rewrites Shared engines on tables', () => {
    const definitions: SchemaDefinition[] = [
      makeTable('events', 'SharedReplacingMergeTree(ingested_at)'),
      makeTable('users', 'SharedMergeTree'),
    ]
    const result = rewriteSharedEngines(definitions)

    expect(result.count).toBe(2)
    expect((result.definitions[0] as { engine: string }).engine).toBe('ReplacingMergeTree(ingested_at)')
    expect((result.definitions[1] as { engine: string }).engine).toBe('MergeTree')
  })

  test('skips views and materialized views', () => {
    const definitions: SchemaDefinition[] = [
      makeTable('events', 'SharedMergeTree'),
      makeView('events_view'),
      makeMaterializedView('events_mv'),
    ]
    const result = rewriteSharedEngines(definitions)

    expect(result.count).toBe(1)
    expect(result.definitions).toHaveLength(3)
    expect(result.definitions[1]).toEqual(makeView('events_view'))
    expect(result.definitions[2]).toEqual(makeMaterializedView('events_mv'))
  })

  test('skips tables without Shared prefix', () => {
    const definitions: SchemaDefinition[] = [
      makeTable('events', 'MergeTree'),
      makeTable('users', 'ReplacingMergeTree(ts)'),
    ]
    const result = rewriteSharedEngines(definitions)

    expect(result.count).toBe(0)
    expect(result.definitions).toEqual(definitions)
  })

  test('handles empty definitions', () => {
    const result = rewriteSharedEngines([])

    expect(result.count).toBe(0)
    expect(result.definitions).toEqual([])
  })

  test('handles mix of Shared and non-Shared tables', () => {
    const definitions: SchemaDefinition[] = [
      makeTable('events', 'SharedReplacingMergeTree(ts)'),
      makeTable('users', 'MergeTree'),
      makeTable('logs', 'SharedMergeTree'),
    ]
    const result = rewriteSharedEngines(definitions)

    expect(result.count).toBe(2)
    expect((result.definitions[0] as { engine: string }).engine).toBe('ReplacingMergeTree(ts)')
    expect((result.definitions[1] as { engine: string }).engine).toBe('MergeTree')
    expect((result.definitions[2] as { engine: string }).engine).toBe('MergeTree')
  })
})

describe('resolveStripBehavior', () => {
  test('--force-shared-engines prevents stripping', () => {
    const config = makeConfig('http://localhost:8123')
    expect(resolveStripBehavior(config, { 'force-shared-engines': true })).toBe(false)
  })

  test('--no-shared-engines forces stripping', () => {
    const config = makeConfig('https://my-cluster.obsessiondb.com:8443')
    expect(resolveStripBehavior(config, { 'no-shared-engines': true })).toBe(true)
  })

  test('--force-shared-engines takes precedence over --no-shared-engines', () => {
    const config = makeConfig('http://localhost:8123')
    expect(resolveStripBehavior(config, { 'force-shared-engines': true, 'no-shared-engines': true })).toBe(false)
  })

  test('auto-detects ObsessionDB host and keeps Shared engines', () => {
    const config = makeConfig('https://my-cluster.obsessiondb.com:8443')
    expect(resolveStripBehavior(config, {})).toBe(false)
  })

  test('auto-detects regular ClickHouse and strips Shared engines', () => {
    const config = makeConfig('http://localhost:8123')
    expect(resolveStripBehavior(config, {})).toBe(true)
  })

  test('strips when no clickhouse config is present', () => {
    const config = makeConfig()
    expect(resolveStripBehavior(config, {})).toBe(true)
  })
})

describe('obsessiondb plugin', () => {
  test('creates typed inline plugin registration', () => {
    const registration = obsessiondb()

    expect(registration.name).toBe('obsessiondb')
    expect(registration.enabled).toBe(true)
    expect(registration.plugin.manifest.name).toBe('obsessiondb')
    expect(registration.plugin.manifest.apiVersion).toBe(1)
  })

  test('registers extendCommands for generate, migrate, status, drift, check', () => {
    const registration = obsessiondb()
    const ext = registration.plugin.extendCommands[0]

    expect(ext?.command).toEqual(['generate', 'migrate', 'status', 'drift', 'check'])
    expect(ext?.flags).toHaveLength(2)
    expect(ext?.flags[0]?.name).toBe('--force-shared-engines')
    expect(ext?.flags[1]?.name).toBe('--no-shared-engines')
  })

  test('onSchemaLoaded strips Shared engines for regular ClickHouse', () => {
    const registration = obsessiondb()
    const definitions: SchemaDefinition[] = [
      makeTable('events', 'SharedReplacingMergeTree(ts)'),
      makeTable('users', 'MergeTree'),
      makeView('events_view'),
    ]

    const result = registration.plugin.hooks.onSchemaLoaded({
      config: makeConfig('http://localhost:8123'),
      flags: {},
      definitions,
    })

    expect(result).toBeDefined()
    expect(result).toHaveLength(3)
    expect((result![0] as { engine: string }).engine).toBe('ReplacingMergeTree(ts)')
    expect((result![1] as { engine: string }).engine).toBe('MergeTree')
    expect(result![2]).toEqual(makeView('events_view'))
  })

  test('onSchemaLoaded is a no-op for ObsessionDB hosts', () => {
    const registration = obsessiondb()
    const definitions: SchemaDefinition[] = [
      makeTable('events', 'SharedReplacingMergeTree(ts)'),
    ]

    const result = registration.plugin.hooks.onSchemaLoaded({
      config: makeConfig('https://my-cluster.obsessiondb.com:8443'),
      flags: {},
      definitions,
    })

    expect(result).toBeUndefined()
  })

  test('onSchemaLoaded returns undefined when no Shared engines exist', () => {
    const registration = obsessiondb()
    const definitions: SchemaDefinition[] = [
      makeTable('events', 'MergeTree'),
    ]

    const result = registration.plugin.hooks.onSchemaLoaded({
      config: makeConfig('http://localhost:8123'),
      flags: {},
      definitions,
    })

    expect(result).toBeDefined()
    expect(result).toHaveLength(1)
  })
})
