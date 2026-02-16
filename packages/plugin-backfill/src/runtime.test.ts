import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveConfig } from '@chkit/core'

import { normalizeBackfillOptions } from './options.js'
import { buildBackfillPlan } from './planner.js'
import {
  cancelBackfillRun,
  evaluateBackfillCheck,
  executeBackfillRun,
  getBackfillDoctorReport,
  getBackfillStatus,
  resumeBackfillRun,
} from './runtime.js'

describe('@chkit/plugin-backfill run lifecycle', () => {
  test('runs plan chunks and reports completed status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chkit/meta',
      })
      const options = normalizeBackfillOptions({ defaults: { chunkHours: 2 } })

      const planned = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        configPath,
        config,
        options,
      })

      const ran = await executeBackfillRun({
        planId: planned.plan.planId,
        configPath,
        config,
        options,
      })

      expect(ran.status.status).toBe('completed')
      expect(ran.status.totals.done).toBe(3)
      expect(ran.status.totals.failed).toBe(0)

      const status = await getBackfillStatus({
        planId: planned.plan.planId,
        configPath,
        config,
        options,
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
      const options = normalizeBackfillOptions({
        defaults: {
          chunkHours: 2,
          maxRetriesPerChunk: 1,
        },
      })

      const planned = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        configPath,
        config,
        options,
      })

      const failChunkId = planned.plan.chunks[1]?.id
      expect(failChunkId).toBeTruthy()

      const firstRun = await executeBackfillRun({
        planId: planned.plan.planId,
        configPath,
        config,
        options,
        execution: {
          simulation: {
            failChunkId,
            failCount: 1,
          },
        },
      })

      expect(firstRun.status.status).toBe('failed')
      expect(firstRun.status.totals.done).toBe(1)
      expect(firstRun.status.totals.failed).toBe(1)

      const resumed = await resumeBackfillRun({
        planId: planned.plan.planId,
        configPath,
        config,
        options,
        execution: {
          replayFailed: true,
        },
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
      const planOptions = normalizeBackfillOptions({
        defaults: { chunkHours: 2, maxRetriesPerChunk: 1 },
      })
      const changedOptions = normalizeBackfillOptions({
        defaults: { chunkHours: 2, maxRetriesPerChunk: 5 },
      })

      const planned = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        configPath,
        config,
        options: planOptions,
      })
      const failChunkId = planned.plan.chunks[1]?.id
      expect(failChunkId).toBeTruthy()

      await executeBackfillRun({
        planId: planned.plan.planId,
        configPath,
        config,
        options: planOptions,
        execution: {
          simulation: { failChunkId, failCount: 1 },
        },
      })

      await expect(
        resumeBackfillRun({
          planId: planned.plan.planId,
          configPath,
          config,
          options: changedOptions,
          execution: { replayFailed: true },
        })
      ).rejects.toThrow('Run compatibility check failed')

      const resumed = await resumeBackfillRun({
        planId: planned.plan.planId,
        configPath,
        config,
        options: changedOptions,
        execution: { replayFailed: true, forceCompatibility: true },
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
      const options = normalizeBackfillOptions({ defaults: { chunkHours: 2 } })

      const planned = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        configPath,
        config,
        options,
      })
      await executeBackfillRun({
        planId: planned.plan.planId,
        configPath,
        config,
        options,
      })

      await expect(
        cancelBackfillRun({
          planId: planned.plan.planId,
          configPath,
          config,
          options,
        })
      ).rejects.toThrow('already completed')

      const options2 = normalizeBackfillOptions({
        defaults: { chunkHours: 2, maxRetriesPerChunk: 1 },
      })
      const planned2 = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-02T00:00:00.000Z',
        to: '2026-01-02T06:00:00.000Z',
        configPath,
        config,
        options: options2,
      })
      await executeBackfillRun({
        planId: planned2.plan.planId,
        configPath,
        config,
        options: options2,
        execution: {
          simulation: { failChunkId: planned2.plan.chunks[1]?.id, failCount: 1 },
        },
      })
      const cancelled = await cancelBackfillRun({
        planId: planned2.plan.planId,
        configPath,
        config,
        options,
      })
      expect(cancelled.status).toBe('cancelled')

      const doctor = await getBackfillDoctorReport({
        planId: planned2.plan.planId,
        configPath,
        config,
        options,
      })
      expect(doctor.issueCodes).toContain('backfill_required_pending')
      expect(doctor.recommendations.join(' ')).toContain('backfill resume')
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
      const options = normalizeBackfillOptions({})

      await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        configPath,
        config,
        options,
      })

      const checkResult = await evaluateBackfillCheck({
        configPath,
        config,
        options,
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
      const options = normalizeBackfillOptions({})

      const planned = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T06:00:00.000Z',
        configPath,
        config,
        options,
      })
      await executeBackfillRun({
        planId: planned.plan.planId,
        configPath,
        config,
        options,
      })

      const checkResult = await evaluateBackfillCheck({
        configPath,
        config,
        options,
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
