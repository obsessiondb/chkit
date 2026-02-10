import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveConfig } from '@chx/core'

import {
  backfill,
  buildBackfillPlan,
  computeBackfillStateDir,
  createBackfillPlugin,
  normalizeBackfillOptions,
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

  test('exposes plan command and typed registration helper', () => {
    const plugin = createBackfillPlugin()
    const registration = backfill({ defaults: { chunkHours: 4 } })

    expect(plugin.manifest.name).toBe('backfill')
    expect(plugin.manifest.apiVersion).toBe(1)
    expect(plugin.commands).toHaveLength(1)
    expect(plugin.commands[0]?.name).toBe('plan')
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
