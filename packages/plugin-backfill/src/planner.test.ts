import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveConfig } from '@chkit/core'

import { normalizeBackfillOptions } from './options.js'
import { buildBackfillPlan } from './planner.js'
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

  test('generates MV replay SQL with CTE wrapping when schema contains materialized view', async () => {
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
      expect(chunk?.sqlTemplate).toContain('WITH _backfill_source AS (')
      expect(chunk?.sqlTemplate).toContain('SELECT toStartOfHour(event_time)')
      expect(chunk?.sqlTemplate).toContain('SELECT * FROM _backfill_source')
      expect(chunk?.sqlTemplate).toContain('parseDateTimeBestEffort(')
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
