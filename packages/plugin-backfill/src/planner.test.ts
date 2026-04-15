import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveConfig } from '@chkit/core'

import { buildChunkExecutionSql, rewriteSelectColumns } from './chunking/sql.js'
import { generateIdempotencyToken } from './chunking/utils/ids.js'
import { PlanSchema } from './options.js'
import { buildBackfillPlan } from './planner.js'
import { backfillPaths, computeBackfillStateDir, readPlan } from './state.js'

function createMockQuery(opts: {
  partitions?: Array<{
    partition_id: string
    total_rows: string
    total_bytes: string
    total_uncompressed_bytes?: string
    min_time: string
    max_time: string
  }>
  sortingKey?: string
  columnRows?: Array<{ name: string; type: string }>
} = {}): <T>(sql: string) => Promise<T[]> {
  const partitions = opts.partitions ?? [
    {
      partition_id: '202601',
      total_rows: '1000',
      total_bytes: '500000',
      total_uncompressed_bytes: '1000000',
      min_time: '2026-01-01 00:00:00',
      max_time: '2026-01-01 18:00:00',
    },
  ]
  const sortingKey = opts.sortingKey ?? 'event_time'
  const columnRows = opts.columnRows ?? [{ name: 'event_time', type: 'DateTime' }]

  return async <T>(sql: string) => {
    if (sql.includes('SELECT 1 FROM')) return [{ ok: 1 }] as T[]
    if (sql.includes('FROM system.parts')) return partitions as T[]
    if (sql.includes('FROM system.tables')) return [{ sorting_key: sortingKey }] as T[]
    if (sql.includes('FROM system.columns')) return columnRows as T[]
    return [] as T[]
  }
}

describe('@chkit/plugin-backfill planning', () => {
  test('each plan gets a unique random id and canonical chunk plan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const opts = PlanSchema.parse({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T18:00:00.000Z',
      })
      const mockQuery = createMockQuery({
        partitions: [
          {
            partition_id: '202601a',
            total_rows: '500',
            total_bytes: '250000',
            total_uncompressed_bytes: '500000',
            min_time: '2026-01-01 00:00:00',
            max_time: '2026-01-01 06:00:00',
          },
          {
            partition_id: '202601b',
            total_rows: '500',
            total_bytes: '250000',
            total_uncompressed_bytes: '500000',
            min_time: '2026-01-01 06:00:00',
            max_time: '2026-01-01 12:00:00',
          },
          {
            partition_id: '202601c',
            total_rows: '500',
            total_bytes: '250000',
            total_uncompressed_bytes: '500000',
            min_time: '2026-01-01 12:00:00',
            max_time: '2026-01-01 18:00:00',
          },
        ],
      })

      const first = await buildBackfillPlan({ opts, configPath, config, clickhouseQuery: mockQuery })
      const second = await buildBackfillPlan({ opts, configPath, config, clickhouseQuery: mockQuery })

      expect(first.plan.planId).not.toBe(second.plan.planId)
      expect(first.plan.planId).toMatch(/^[a-f0-9]{16}$/)
      expect(first.plan.chunkPlan.chunks).toHaveLength(3)

      const chunk = first.plan.chunkPlan.chunks[0]
      const token = chunk ? generateIdempotencyToken(first.plan.planId, chunk.id) : ''
      const sql = chunk
        ? buildChunkExecutionSql({
          planId: first.plan.planId,
          chunk,
          target: first.plan.target,
          sourceTarget: first.plan.execution.sourceTarget,
          table: first.plan.chunkPlan.table,
          idempotencyToken: token,
        })
        : ''

      expect(token).toHaveLength(64)
      expect(sql).toContain('INSERT INTO app.events')
      expect(sql).toContain(`insert_deduplication_token='${token}'`)
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
      const opts = PlanSchema.parse({ target: 'app.events' })
      const output = await buildBackfillPlan({ opts, configPath, config, clickhouseQuery: createMockQuery() })

      const raw = await readFile(output.planPath, 'utf8')
      const persisted = JSON.parse(raw) as { planId: string; chunkPlan: { chunks: Array<{ id: string }> } }
      expect(persisted.planId).toBe(output.plan.planId)
      expect(persisted.chunkPlan.chunks.length).toBe(1)
      expect(output.planPath).toContain('/plans/')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('detects sort key column from ClickHouse metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const opts = PlanSchema.parse({ target: 'app.events' })
      const output = await buildBackfillPlan({
        opts,
        configPath,
        config,
        clickhouseQuery: createMockQuery({
          sortingKey: 'session_date',
          columnRows: [{ name: 'session_date', type: 'Date' }],
        }),
      })

      expect(output.plan.chunkPlan.table.sortKeys[0]?.name).toBe('session_date')
      expect(output.plan.chunkPlan.table.sortKeys[0]?.category).toBe('datetime')
      expect(output.plan.options.sortKeyColumn).toBe('session_date')
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

    const defaultDir = computeBackfillStateDir(config, configPath)
    const overriddenDir = computeBackfillStateDir(config, configPath, './custom-state')

    expect(defaultDir).toBe(resolve('/tmp/project/chkit/meta/backfill'))
    expect(overriddenDir).toBe(resolve('/tmp/project/custom-state'))
  })

  test('generates MV replay execution metadata and SQL when schema contains materialized view', async () => {
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
      const opts = PlanSchema.parse({ target: 'app.events_agg' })
      const output = await buildBackfillPlan({ opts, configPath, config, clickhouseQuery: createMockQuery() })

      expect(output.plan.execution.mode).toBe('mv_replay')

      const chunk = output.plan.chunkPlan.chunks[0]
      const sql = chunk
        ? buildChunkExecutionSql({
          planId: output.plan.planId,
          chunk,
          target: output.plan.target,
          sourceTarget: output.plan.execution.sourceTarget,
          table: output.plan.chunkPlan.table,
          mvAsQuery: output.plan.execution.mvAsQuery,
          targetColumns: output.plan.execution.targetColumns,
          idempotencyToken: generateIdempotencyToken(output.plan.planId, chunk.id),
        })
        : ''

      expect(sql).toContain('INSERT INTO app.events_agg')
      expect(sql).toContain('SELECT toStartOfHour(event_time)')
      expect(sql).toContain('FROM app.events')
      expect(sql).toContain('GROUP BY event_time')
      expect(sql).toContain('SETTINGS async_insert=0')
      expect(sql).not.toContain('FROM app.events_agg')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('MV replay rewrites SELECT columns to match target table order', () => {
    const rewritten = rewriteSelectColumns(
      "SELECT *, extractAll(content, 'skill') AS skills, extractAll(content, 'cmd') AS slash_commands FROM app.raw_sessions",
      ['session_date', 'session_id', 'skills', 'slash_commands', 'ingested_at']
    )

    expect(rewritten).toContain('SELECT session_date, session_id, extractAll(content, \'skill\') AS skills, extractAll(content, \'cmd\') AS slash_commands, ingested_at')
    expect(rewritten).toContain('FROM app.raw_sessions')
  })

  test('MV replay preserves DISTINCT when rewriting projection columns', () => {
    const rewritten = rewriteSelectColumns(
      'SELECT DISTINCT event_time AS ts, user_id AS uid FROM app.events',
      ['uid', 'ts']
    )

    expect(rewritten).toContain('SELECT DISTINCT user_id AS uid, event_time AS ts')
    expect(rewritten).toContain('FROM app.events')
  })

  test('omits idempotency token when disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const opts = PlanSchema.parse({ target: 'app.events', requireIdempotencyToken: false })
      const output = await buildBackfillPlan({ opts, configPath, config, clickhouseQuery: createMockQuery() })

      const chunk = output.plan.chunkPlan.chunks[0]
      const sql = chunk
        ? buildChunkExecutionSql({
          planId: output.plan.planId,
          chunk,
          target: output.plan.target,
          sourceTarget: output.plan.execution.sourceTarget,
          table: output.plan.chunkPlan.table,
          idempotencyToken: '',
        })
        : ''

      expect(output.plan.execution.requireIdempotencyToken).toBe(false)
      expect(sql).toContain('SETTINGS async_insert=0')
      expect(sql).not.toContain('insert_deduplication_token')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects persisted legacy plans with an actionable error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')
    const planId = 'deadbeefdeadbeef'

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const stateDir = computeBackfillStateDir(config, configPath)
      const { planPath } = backfillPaths(stateDir, planId)
      await mkdir(dirname(planPath), { recursive: true })

      await writeFile(planPath, JSON.stringify({
        planId,
        target: 'app.events',
        createdAt: '2026-01-01T00:00:00.000Z',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T01:00:00.000Z',
        chunks: [],
      }))

      await expect(readPlan({
        planId,
        configPath,
        config,
      })).rejects.toThrow('uses a previous chunking format')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
