import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveConfig } from '@chx/core'

import {
  backfill,
  buildBackfillPlan,
  cancelBackfillRun,
  computeBackfillStateDir,
  createBackfillPlugin,
  evaluateBackfillCheck,
  executeBackfillRun,
  getBackfillDoctorReport,
  getBackfillStatus,
  normalizeBackfillOptions,
  resumeBackfillRun,
} from './index'

describe('@chx/plugin-backfill options', () => {
  test('normalizes documented defaults', () => {
    const options = normalizeBackfillOptions()

    expect(options.defaults.chunkHours).toBe(6)
    expect(options.defaults.maxParallelChunks).toBe(1)
    expect(options.defaults.maxRetriesPerChunk).toBe(3)
    expect(options.defaults.requireIdempotencyToken).toBe(true)
    expect(options.policy.requireDryRunBeforeRun).toBe(true)
    expect(options.policy.requireExplicitWindow).toBe(true)
    expect(options.policy.blockOverlappingRuns).toBe(true)
    expect(options.policy.failCheckOnRequiredPendingBackfill).toBe(true)
    expect(options.limits.maxWindowHours).toBe(24 * 30)
    expect(options.limits.minChunkMinutes).toBe(15)
  })

  test('exposes commands and typed registration helper', () => {
    const plugin = createBackfillPlugin()
    const registration = backfill({ defaults: { chunkHours: 4 } })

    expect(plugin.manifest.name).toBe('backfill')
    expect(plugin.manifest.apiVersion).toBe(1)
    expect(plugin.commands.map((command) => command.name)).toEqual([
      'plan',
      'run',
      'resume',
      'status',
      'cancel',
      'doctor',
    ])
    expect(registration.name).toBe('backfill')
    expect(registration.enabled).toBe(true)
    expect(registration.options?.defaults?.chunkHours).toBe(4)
  })
})

describe('@chx/plugin-backfill planning', () => {
  test('builds deterministic plan id and chunks for identical input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chx-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chx/meta',
      })
      const options = normalizeBackfillOptions({})

      const first = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T18:00:00.000Z',
        configPath,
        config,
        options,
      })

      const second = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T18:00:00.000Z',
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
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes immutable plan state to plans directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chx-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chx/meta',
      })
      const options = normalizeBackfillOptions({})

      const output = await buildBackfillPlan({
        target: 'app.events',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T07:00:00.000Z',
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

  test('computes state dir from config by default and plugin override', () => {
    const config = resolveConfig({
      schema: './schema.ts',
      metaDir: './chx/meta',
    })
    const configPath = '/tmp/project/clickhouse.config.ts'

    const defaultDir = computeBackfillStateDir(config, configPath, normalizeBackfillOptions())
    const overriddenDir = computeBackfillStateDir(
      config,
      configPath,
      normalizeBackfillOptions({ stateDir: './custom-state' })
    )

    expect(defaultDir).toBe(resolve('/tmp/project/chx/meta/backfill'))
    expect(overriddenDir).toBe(resolve('/tmp/project/custom-state'))
  })
})

describe('@chx/plugin-backfill run lifecycle', () => {
  test('runs plan chunks and reports completed status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chx-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chx/meta',
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
    const dir = await mkdtemp(join(tmpdir(), 'chx-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chx/meta',
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
    const dir = await mkdtemp(join(tmpdir(), 'chx-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chx/meta',
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
    const dir = await mkdtemp(join(tmpdir(), 'chx-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chx/meta',
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

describe('@chx/plugin-backfill check integration', () => {
  test('reports pending required backfills when plan exists but run is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chx-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chx/meta',
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
    const dir = await mkdtemp(join(tmpdir(), 'chx-backfill-plugin-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      const config = resolveConfig({
        schema: './schema.ts',
        metaDir: './chx/meta',
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
