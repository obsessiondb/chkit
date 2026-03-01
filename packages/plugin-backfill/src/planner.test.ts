import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveConfig } from '@chkit/core'

import { normalizeBackfillOptions } from './options.js'
import { buildBackfillPlan, injectTimeFilter } from './planner.js'
import { computeBackfillStateDir } from './state.js'

describe('@chkit/plugin-backfill planning', () => {
  test('builds deterministic plan id and chunks for identical input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const options = normalizeBackfillOptions({})

      const first = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T18:00:00.000Z',
        timeColumn: 'event_time',
        configPath,
        config,
        options,
      })

      const second = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T18:00:00.000Z',
        timeColumn: 'event_time',
        configPath,
        config,
        options,
      })

      expect(first.plan.planId).toBe(second.plan.planId)
      expect(first.plan.chunks).toEqual(second.plan.chunks)
      expect(first.existed).toBe(false)
      expect(second.existed).toBe(true)
      expect(first.plan.chunks).toHaveLength(3)

      const chunk = first.plan.chunks[0]
      expect(chunk?.idempotencyToken.length).toBe(64)
      expect(chunk?.sqlTemplate).toContain('INSERT INTO app.events')
      expect(chunk?.sqlTemplate).toContain('parseDateTimeBestEffort(')
      expect(chunk?.sqlTemplate).toContain(`insert_deduplication_token='${chunk?.idempotencyToken}'`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes immutable plan state to plans directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const options = normalizeBackfillOptions({})

      const output = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T07:00:00.000Z',
        timeColumn: 'event_time',
        configPath,
        config,
        options,
        chunkHours: 2,
      })

      const raw = await readFile(output.planPath, 'utf8')
      const persisted = JSON.parse(raw) as { planId: string; chunks: Array<{ id: string }> }
      expect(persisted.planId).toBe(output.plan.planId)
      expect(persisted.chunks.length).toBe(4)
      expect(output.planPath).toContain('/plans/')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('uses provided time column name in SQL template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const options = normalizeBackfillOptions({})

      const output = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        timeColumn: 'session_date',
        configPath,
        config,
        options,
      })

      const chunk = output.plan.chunks[0]
      expect(chunk?.sqlTemplate).toContain("WHERE session_date >= parseDateTimeBestEffort('")
      expect(chunk?.sqlTemplate).toContain("AND session_date < parseDateTimeBestEffort('")
      expect(chunk?.sqlTemplate).not.toContain('event_time')
      expect(output.plan.options.timeColumn).toBe('session_date')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('different time columns produce different plan IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const options = normalizeBackfillOptions({})

      const planA = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        timeColumn: 'event_time',
        configPath,
        config,
        options,
      })

      const planB = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        timeColumn: 'created_at',
        configPath,
        config,
        options,
      })

      expect(planA.plan.planId).not.toBe(planB.plan.planId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('computes state dir from config by default and plugin override', () => {
    const config = resolveConfig({
      schema: './schema.ts',
      metaDir: './chkit/meta',
    })
    const configPath = '/tmp/project/clickhouse.config.ts'

    const defaultDir = computeBackfillStateDir(config, configPath, normalizeBackfillOptions())
    const overriddenDir = computeBackfillStateDir(
      config,
      configPath,
      normalizeBackfillOptions({ stateDir: './custom-state' })
    )

    expect(defaultDir).toBe(resolve('/tmp/project/chkit/meta/backfill'))
    expect(overriddenDir).toBe(resolve('/tmp/project/custom-state'))
  })

  test('generates MV replay SQL with inline time filter when schema contains materialized view', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')
    const schemaPath = join(dir, 'schema.ts')

    try {
      await writeFile(
        schemaPath,
        `export const events_target = {
  kind: 'table',
  database: 'app',
  name: 'events_agg',
  columns: [
    { name: 'event_time', type: 'DateTime' },
    { name: 'count', type: 'UInt64' },
  ],
  engine: 'MergeTree',
  primaryKey: ['event_time'],
  orderBy: ['event_time'],
}
export const events_mv = {
  kind: 'materialized_view',
  database: 'app',
  name: 'events_mv',
  to: { database: 'app', name: 'events_agg' },
  as: 'SELECT toStartOfHour(event_time) AS event_time, count() AS count FROM app.events GROUP BY event_time',
}
`
      )

      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const options = normalizeBackfillOptions({})

      const output = await buildBackfillPlan({
        target: 'app.events_agg',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        timeColumn: 'event_time',
        configPath,
        config,
        options,
      })

      expect(output.plan.strategy).toBe('mv_replay')

      const chunk = output.plan.chunks[0]
      expect(chunk?.sqlTemplate).toContain('INSERT INTO app.events_agg')
      // Time filter is injected directly into the MV query (before GROUP BY), not via CTE
      expect(chunk?.sqlTemplate).not.toContain('WITH _backfill_source AS (')
      expect(chunk?.sqlTemplate).not.toContain('SELECT * FROM _backfill_source')
      expect(chunk?.sqlTemplate).toContain('SELECT toStartOfHour(event_time)')
      expect(chunk?.sqlTemplate).toContain('FROM app.events')
      expect(chunk?.sqlTemplate).toContain("WHERE event_time >= parseDateTimeBestEffort('")
      expect(chunk?.sqlTemplate).toContain("AND event_time < parseDateTimeBestEffort('")
      expect(chunk?.sqlTemplate).toContain('GROUP BY event_time')
      expect(chunk?.sqlTemplate).toContain('SETTINGS async_insert=0')
      expect(chunk?.sqlTemplate).toContain(`insert_deduplication_token='${chunk?.idempotencyToken}'`)
      expect(chunk?.sqlTemplate).not.toContain('FROM app.events_agg')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('omits insert_deduplication_token when requireIdempotencyToken is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const options = normalizeBackfillOptions({
        defaults: { requireIdempotencyToken: false },
      })

      const output = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        timeColumn: 'event_time',
        configPath,
        config,
        options,
      })

      const chunk = output.plan.chunks[0]
      expect(chunk?.idempotencyToken).toBe('')
      expect(chunk?.sqlTemplate).toContain('SETTINGS async_insert=0')
      expect(chunk?.sqlTemplate).not.toContain('insert_deduplication_token')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('falls back to table strategy when no schema matches MV target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const options = normalizeBackfillOptions({})

      const output = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        timeColumn: 'event_time',
        configPath,
        config,
        options,
      })

      expect(output.plan.strategy).toBe('table')

      const chunk = output.plan.chunks[0]
      expect(chunk?.sqlTemplate).toContain('INSERT INTO app.events')
      expect(chunk?.sqlTemplate).toContain('FROM app.events')
      expect(chunk?.sqlTemplate).toContain('parseDateTimeBestEffort(')
      expect(chunk?.sqlTemplate).toContain('SETTINGS async_insert=0')
      expect(chunk?.sqlTemplate).not.toContain('_backfill_source')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('injectTimeFilter', () => {
  const from = '2025-01-01T00:00:00.000Z'
  const to = '2025-01-01T06:00:00.000Z'

  test('injects WHERE before GROUP BY when query has no WHERE clause', () => {
    const query = 'SELECT toStartOfHour(event_time) AS event_time, count() AS count FROM app.events GROUP BY event_time'
    const result = injectTimeFilter(query, 'event_time', from, to)

    expect(result).toContain("WHERE event_time >= parseDateTimeBestEffort('2025-01-01T00:00:00.000Z')")
    expect(result).toContain("AND event_time < parseDateTimeBestEffort('2025-01-01T06:00:00.000Z')")
    expect(result).toContain('GROUP BY event_time')
    // WHERE must appear before GROUP BY
    expect(result.indexOf('WHERE')).toBeLessThan(result.indexOf('GROUP BY'))
  })

  test('appends AND to existing WHERE clause', () => {
    const query = 'SELECT * FROM app.events WHERE status = 1'
    const result = injectTimeFilter(query, 'event_time', from, to)

    expect(result).toContain('WHERE status = 1')
    expect(result).toContain("AND event_time >= parseDateTimeBestEffort('")
    expect(result).toContain("AND event_time < parseDateTimeBestEffort('")
    // Should NOT add a second WHERE
    expect(result.match(/WHERE/g)?.length).toBe(1)
  })

  test('appends AND before GROUP BY when query has WHERE and GROUP BY', () => {
    const query = 'SELECT id, count() AS c FROM app.events WHERE status = 1 GROUP BY id'
    const result = injectTimeFilter(query, 'ts', from, to)

    expect(result).toContain('WHERE status = 1')
    expect(result).toContain("AND ts >= parseDateTimeBestEffort('")
    expect(result.indexOf('AND ts')).toBeLessThan(result.indexOf('GROUP BY'))
  })

  test('handles query with WHERE and QUALIFY', () => {
    const query = [
      'SELECT *, skills',
      'FROM app.sessions AS s',
      'WHERE length(timestamps) > 0',
      "QUALIFY ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY s.ts DESC) = 1",
    ].join('\n')
    const result = injectTimeFilter(query, 'session_date', from, to)

    expect(result).toContain('WHERE length(timestamps) > 0')
    expect(result).toContain("AND session_date >= parseDateTimeBestEffort('")
    expect(result.indexOf('AND session_date')).toBeLessThan(result.indexOf('QUALIFY'))
  })

  test('handles MV query with WITH column expressions (Array-producing aliases)', () => {
    const query = [
      'WITH',
      "  arrayDistinct(arrayFilter(x -> x != '', extractAll(content, '\\\\w+'))) AS _skills",
      'SELECT',
      '  id,',
      '  _skills as skills,',
      '  ts',
      'FROM app.sessions',
      'WHERE length(content) > 0',
    ].join('\n')
    const result = injectTimeFilter(query, 'ts', from, to)

    // Should append AND, not add new WHERE
    expect(result.match(/WHERE/g)?.length).toBe(1)
    expect(result).toContain("AND ts >= parseDateTimeBestEffort('")
    // WITH clause must remain intact
    expect(result).toContain('arrayDistinct')
  })

  test('injects WHERE at end when query has no WHERE and no trailing clauses', () => {
    const query = 'SELECT * FROM app.events'
    const result = injectTimeFilter(query, 'event_time', from, to)

    expect(result).toContain("WHERE event_time >= parseDateTimeBestEffort('")
    expect(result).toContain("AND event_time < parseDateTimeBestEffort('")
  })

  test('ignores WHERE inside parenthesized subquery', () => {
    const query = 'SELECT * FROM (SELECT * FROM app.events WHERE inner = 1) AS sub GROUP BY id'
    const result = injectTimeFilter(query, 'ts', from, to)

    // The inner WHERE is inside parens, so it must inject a new top-level WHERE before GROUP BY
    expect(result).toContain("WHERE ts >= parseDateTimeBestEffort('")
    expect(result.indexOf("WHERE ts")).toBeLessThan(result.indexOf('GROUP BY'))
    // Inner WHERE must remain intact
    expect(result).toContain('WHERE inner = 1')
  })
})
