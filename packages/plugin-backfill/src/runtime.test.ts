import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveConfig } from '@chkit/core'

import { PlanSchema, RunSchema, ResumeSchema } from './options.js'
import { buildBackfillPlan } from './planner.js'
import { evaluateBackfillCheck } from './check.js'
import { cancelBackfillRun, getBackfillDoctorReport, getBackfillStatus } from './queries.js'
import { executeBackfillRun, resumeBackfillRun } from './runtime.js'

function createMockQuery(opts: {
  partitions?: Array<{ partition_id: string; total_rows: string; total_bytes: string; min_time: string; max_time: string }>
} = {}): <T>(sql: string) => Promise<T[]> {
  const partitions = opts.partitions ?? [
    { partition_id: '202601a', total_rows: '500', total_bytes: '250000', min_time: '2026-01-01 00:00:00', max_time: '2026-01-01 02:00:00' },
    { partition_id: '202601b', total_rows: '500', total_bytes: '250000', min_time: '2026-01-01 02:00:00', max_time: '2026-01-01 04:00:00' },
    { partition_id: '202601c', total_rows: '500', total_bytes: '250000', min_time: '2026-01-01 04:00:00', max_time: '2026-01-01 06:00:00' },
  ]

  return async <T>(sql: string) => {
    if (sql.includes('system.parts')) return partitions as T[]
    if (sql.includes('system.tables')) return [{ sorting_key: 'event_time' }] as T[]
    if (sql.includes('system.columns')) return [{ type: 'DateTime' }] as T[]
    return [] as T[]
  }
}

describe('@chkit/plugin-backfill run lifecycle', () => {
  test('runs plan chunks and reports completed status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const planOpts = PlanSchema.parse({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
      })

      const planned = await buildBackfillPlan({
        opts: planOpts,
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })

      const runOpts = RunSchema.parse({ planId: planned.plan.planId })
      const ran = await executeBackfillRun({
        opts: runOpts,
        configPath,
        config,
      })

      expect(ran.status.status).toBe('completed')
      expect(ran.status.totals.done).toBe(3)
      expect(ran.status.totals.failed).toBe(0)

      const status = await getBackfillStatus({
        planId: planned.plan.planId,
        configPath,
        config,
      })
      expect(status.status).toBe('completed')
      expect(status.totals.done).toBe(3)
      expect(status.runPath).toContain('/runs/')
      expect(status.eventPath).toContain('/events/')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('supports fail then resume without replaying done chunks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const planOpts = PlanSchema.parse({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        maxRetriesPerChunk: 1,
      })

      const planned = await buildBackfillPlan({
        opts: planOpts,
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })

      const failChunkId = planned.plan.chunks[1]?.id
      expect(failChunkId).toBeTruthy()

      const runOpts = RunSchema.parse({
        planId: planned.plan.planId,
        maxRetriesPerChunk: 1,
        retryDelayMs: 0,
        simulateFailChunk: failChunkId,
        simulateFailCount: 1,
      })
      const firstRun = await executeBackfillRun({
        opts: runOpts,
        configPath,
        config,
      })

      expect(firstRun.status.status).toBe('failed')
      expect(firstRun.status.totals.done).toBe(2)
      expect(firstRun.status.totals.failed).toBe(1)

      const resumeOpts = ResumeSchema.parse({
        planId: planned.plan.planId,
        maxRetriesPerChunk: 1,
        retryDelayMs: 0,
        replayFailed: true,
      })
      const resumed = await resumeBackfillRun({
        opts: resumeOpts,
        configPath,
        config,
      })

      expect(resumed.status.status).toBe('completed')
      expect(resumed.status.totals.done).toBe(3)

      const runRaw = JSON.parse(await readFile(resumed.runPath, 'utf8')) as {
        chunks: Array<{ id: string; attempts: number }>
      }
      const firstChunk = planned.plan.chunks[0]
      const firstChunkState = runRaw.chunks.find((chunk) => chunk.id === firstChunk?.id)
      expect(firstChunkState?.attempts).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('blocks resume on compatibility mismatch unless forceCompatibility is enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const planOpts = PlanSchema.parse({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        maxRetriesPerChunk: 1,
      })

      const planned = await buildBackfillPlan({
        opts: planOpts,
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })
      const failChunkId = planned.plan.chunks[1]?.id
      expect(failChunkId).toBeTruthy()

      const runOpts = RunSchema.parse({
        planId: planned.plan.planId,
        maxRetriesPerChunk: 1,
        retryDelayMs: 0,
        simulateFailChunk: failChunkId,
        simulateFailCount: 1,
      })
      await executeBackfillRun({
        opts: runOpts,
        configPath,
        config,
      })

      await expect(
        resumeBackfillRun({
          opts: ResumeSchema.parse({
            planId: planned.plan.planId,
            maxRetriesPerChunk: 5,
            retryDelayMs: 0,
            replayFailed: true,
          }),
          configPath,
          config,
        })
      ).rejects.toThrow('Run compatibility check failed')

      const resumed = await resumeBackfillRun({
        opts: ResumeSchema.parse({
          planId: planned.plan.planId,
          maxRetriesPerChunk: 5,
          retryDelayMs: 0,
          replayFailed: true,
          forceCompatibility: true,
        }),
        configPath,
        config,
      })
      expect(resumed.status.status).toBe('completed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('cancel marks run as cancelled and doctor reports actionable remediation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const planOpts = PlanSchema.parse({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
      })

      const planned = await buildBackfillPlan({
        opts: planOpts,
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })
      await executeBackfillRun({
        opts: RunSchema.parse({ planId: planned.plan.planId }),
        configPath,
        config,
      })

      await expect(
        cancelBackfillRun({
          planId: planned.plan.planId,
          configPath,
          config,
        })
      ).rejects.toThrow('already completed')

      const planOpts2 = PlanSchema.parse({
        target: 'app.events',
        from: '2026-01-02T00:00:00.000Z',
        to: '2026-01-02T06:00:00.000Z',
        maxRetriesPerChunk: 1,
      })
      const planned2 = await buildBackfillPlan({
        opts: planOpts2,
        configPath,
        config,
        clickhouseQuery: createMockQuery({
          partitions: [
            { partition_id: '202601d', total_rows: '500', total_bytes: '250000', min_time: '2026-01-02 00:00:00', max_time: '2026-01-02 02:00:00' },
            { partition_id: '202601e', total_rows: '500', total_bytes: '250000', min_time: '2026-01-02 02:00:00', max_time: '2026-01-02 04:00:00' },
            { partition_id: '202601f', total_rows: '500', total_bytes: '250000', min_time: '2026-01-02 04:00:00', max_time: '2026-01-02 06:00:00' },
          ],
        }),
      })
      await executeBackfillRun({
        opts: RunSchema.parse({
          planId: planned2.plan.planId,
          maxRetriesPerChunk: 1,
          retryDelayMs: 0,
          simulateFailChunk: planned2.plan.chunks[1]?.id,
          simulateFailCount: 1,
        }),
        configPath,
        config,
      })
      const cancelled = await cancelBackfillRun({
        planId: planned2.plan.planId,
        configPath,
        config,
      })
      expect(cancelled.status).toBe('cancelled')

      const doctor = await getBackfillDoctorReport({
        planId: planned2.plan.planId,
        configPath,
        config,
      })
      expect(doctor.issueCodes).toContain('backfill_required_pending')
      expect(doctor.recommendations.join(' ')).toContain('backfill resume')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('@chkit/plugin-backfill execute callback', () => {
  test('calls execute for each chunk when provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })

      const planned = await buildBackfillPlan({
        opts: PlanSchema.parse({
          target: 'app.events',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-01T06:00:00.000Z',
        }),
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })

      const executedSql: string[] = []
      const execute = async (sql: string) => {
        executedSql.push(sql)
      }

      const ran = await executeBackfillRun({
        opts: RunSchema.parse({ planId: planned.plan.planId }),
        configPath,
        config,
        execute,
      })

      expect(ran.status.status).toBe('completed')
      expect(ran.status.totals.done).toBe(3)
      expect(executedSql).toHaveLength(3)
      for (const sql of executedSql) {
        expect(sql).toContain('INSERT INTO app.events')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('retries and succeeds chunk when execute fails then recovers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })

      const planned = await buildBackfillPlan({
        opts: PlanSchema.parse({
          target: 'app.events',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-01T06:00:00.000Z',
          maxRetriesPerChunk: 3,
        }),
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })

      let callCount = 0
      const execute = async (_sql: string) => {
        callCount++
        if (callCount === 1) {
          throw new Error('Temporary network error')
        }
      }

      const ran = await executeBackfillRun({
        opts: RunSchema.parse({
          planId: planned.plan.planId,
          maxRetriesPerChunk: 3,
          retryDelayMs: 0,
        }),
        configPath,
        config,
        execute,
      })

      expect(ran.status.status).toBe('completed')
      expect(ran.status.totals.done).toBe(3)
      expect(ran.status.totals.failed).toBe(0)

      const firstChunkState = ran.run.chunks[0]
      expect(firstChunkState?.attempts).toBe(2)
      expect(firstChunkState?.lastError).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('retries and fails chunk when execute throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })

      const planned = await buildBackfillPlan({
        opts: PlanSchema.parse({
          target: 'app.events',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-01T06:00:00.000Z',
          maxRetriesPerChunk: 2,
        }),
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })

      let callCount = 0
      const execute = async (_sql: string) => {
        callCount++
        if (callCount <= 2) {
          throw new Error('Connection refused')
        }
      }

      const ran = await executeBackfillRun({
        opts: RunSchema.parse({
          planId: planned.plan.planId,
          maxRetriesPerChunk: 2,
          retryDelayMs: 0,
        }),
        configPath,
        config,
        execute,
      })

      expect(ran.status.status).toBe('failed')
      expect(ran.status.totals.failed).toBe(1)
      expect(ran.status.lastError).toContain('Connection refused')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('@chkit/plugin-backfill continue past failures', () => {
  test('continues to remaining chunks after a chunk fails permanently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })

      const planned = await buildBackfillPlan({
        opts: PlanSchema.parse({
          target: 'app.events',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-01T06:00:00.000Z',
          maxRetriesPerChunk: 1,
        }),
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })

      const failChunkId = planned.plan.chunks[0]?.id
      expect(failChunkId).toBeTruthy()

      const ran = await executeBackfillRun({
        opts: RunSchema.parse({
          planId: planned.plan.planId,
          maxRetriesPerChunk: 1,
          retryDelayMs: 0,
          simulateFailChunk: failChunkId,
          simulateFailCount: 1,
        }),
        configPath,
        config,
      })

      expect(ran.status.status).toBe('failed')
      expect(ran.status.totals.done).toBe(2)
      expect(ran.status.totals.failed).toBe(1)
      expect(ran.run.chunks[0]?.status).toBe('failed')
      expect(ran.run.chunks[1]?.status).toBe('done')
      expect(ran.run.chunks[2]?.status).toBe('done')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('resume retries failed chunks without requiring --replay-failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })

      const planned = await buildBackfillPlan({
        opts: PlanSchema.parse({
          target: 'app.events',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-01T06:00:00.000Z',
          maxRetriesPerChunk: 1,
        }),
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })

      const failChunkId = planned.plan.chunks[1]?.id
      expect(failChunkId).toBeTruthy()

      await executeBackfillRun({
        opts: RunSchema.parse({
          planId: planned.plan.planId,
          maxRetriesPerChunk: 1,
          retryDelayMs: 0,
          simulateFailChunk: failChunkId,
          simulateFailCount: 1,
        }),
        configPath,
        config,
      })

      const resumed = await resumeBackfillRun({
        opts: ResumeSchema.parse({
          planId: planned.plan.planId,
          maxRetriesPerChunk: 1,
          retryDelayMs: 0,
        }),
        configPath,
        config,
      })

      expect(resumed.status.status).toBe('completed')
      expect(resumed.status.totals.done).toBe(3)
      expect(resumed.status.totals.failed).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('@chkit/plugin-backfill check integration', () => {
  test('reports pending required backfills when plan exists but run is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })

      await buildBackfillPlan({
        opts: PlanSchema.parse({
          target: 'app.events',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-01T06:00:00.000Z',
        }),
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })

      const checkResult = await evaluateBackfillCheck({
        configPath,
        config,
        failCheckOnRequiredPendingBackfill: true,
      })

      expect(checkResult.ok).toBe(false)
      expect(checkResult.findings.map((finding) => finding.code)).toContain('backfill_required_pending')
      expect(checkResult.metadata?.requiredCount).toBe(1)
      expect(checkResult.metadata?.activeRuns).toBe(0)
      expect(checkResult.metadata?.failedRuns).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reports ok after completed run and emits no finding codes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })

      const planned = await buildBackfillPlan({
        opts: PlanSchema.parse({
          target: 'app.events',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-01T06:00:00.000Z',
        }),
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })
      await executeBackfillRun({
        opts: RunSchema.parse({ planId: planned.plan.planId }),
        configPath,
        config,
      })

      const checkResult = await evaluateBackfillCheck({
        configPath,
        config,
        failCheckOnRequiredPendingBackfill: true,
      })

      expect(checkResult.ok).toBe(true)
      expect(checkResult.findings).toEqual([])
      expect(checkResult.metadata?.requiredCount).toBe(0)
      expect(checkResult.metadata?.failedRuns).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('@chkit/plugin-backfill environment binding', () => {
  test('rejects run against mismatched environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const stagingCh = { url: 'https://staging.ch.cloud:8443', database: 'analytics' }
      const prodCh = { url: 'https://prod.ch.cloud:8443', database: 'analytics' }

      const planned = await buildBackfillPlan({
        opts: PlanSchema.parse({ target: 'app.events', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T06:00:00.000Z' }),
        configPath,
        config,
        clickhouse: stagingCh,
        clickhouseQuery: createMockQuery(),
      })

      await expect(
        executeBackfillRun({
          opts: RunSchema.parse({ planId: planned.plan.planId }),
          configPath,
          config,
          clickhouse: prodCh,
        })
      ).rejects.toThrow('Environment mismatch')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('--force-environment overrides mismatch check', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const stagingCh = { url: 'https://staging.ch.cloud:8443', database: 'analytics' }
      const prodCh = { url: 'https://prod.ch.cloud:8443', database: 'analytics' }

      const planned = await buildBackfillPlan({
        opts: PlanSchema.parse({ target: 'app.events', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T06:00:00.000Z' }),
        configPath,
        config,
        clickhouse: stagingCh,
        clickhouseQuery: createMockQuery(),
      })

      const ran = await executeBackfillRun({
        opts: RunSchema.parse({ planId: planned.plan.planId, forceEnvironment: true }),
        configPath,
        config,
        clickhouse: prodCh,
      })

      expect(ran.status.status).toBe('completed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('plans without environment connection info can run against any environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })

      const planned = await buildBackfillPlan({
        opts: PlanSchema.parse({ target: 'app.events', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T06:00:00.000Z' }),
        configPath,
        config,
        clickhouseQuery: createMockQuery(),
      })

      expect(planned.plan.environment).toBeUndefined()

      const ran = await executeBackfillRun({
        opts: RunSchema.parse({ planId: planned.plan.planId }),
        configPath,
        config,
        clickhouse: { url: 'https://prod.ch.cloud:8443', database: 'analytics' },
      })

      expect(ran.status.status).toBe('completed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects resume against mismatched environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const stagingCh = { url: 'https://staging.ch.cloud:8443', database: 'analytics' }
      const prodCh = { url: 'https://prod.ch.cloud:8443', database: 'analytics' }

      const planned = await buildBackfillPlan({
        opts: PlanSchema.parse({ target: 'app.events', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T06:00:00.000Z', maxRetriesPerChunk: 1 }),
        configPath,
        config,
        clickhouse: stagingCh,
        clickhouseQuery: createMockQuery(),
      })

      await executeBackfillRun({
        opts: RunSchema.parse({
          planId: planned.plan.planId,
          maxRetriesPerChunk: 1,
          retryDelayMs: 0,
          simulateFailChunk: planned.plan.chunks[1]?.id,
          simulateFailCount: 1,
        }),
        configPath,
        config,
        clickhouse: stagingCh,
      })

      await expect(
        resumeBackfillRun({
          opts: ResumeSchema.parse({
            planId: planned.plan.planId,
            maxRetriesPerChunk: 1,
            retryDelayMs: 0,
            replayFailed: true,
          }),
          configPath,
          config,
          clickhouse: prodCh,
        })
      ).rejects.toThrow('Environment mismatch')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
