import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
})
