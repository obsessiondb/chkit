import { describe, expect, test } from 'bun:test'

import { mergeOptions, normalizeBackfillOptions } from './options.js'

describe('@chkit/plugin-backfill options', () => {
  test('normalizes documented defaults', () => {
    const options = normalizeBackfillOptions()

    expect(options.defaults.chunkHours).toBe(6)
    expect(options.defaults.maxParallelChunks).toBe(1)
    expect(options.defaults.maxRetriesPerChunk).toBe(3)
    expect(options.defaults.requireIdempotencyToken).toBe(true)
    expect(options.defaults.timeColumn).toBeUndefined()
    expect(options.policy.requireDryRunBeforeRun).toBe(true)
    expect(options.policy.requireExplicitWindow).toBe(true)
    expect(options.policy.blockOverlappingRuns).toBe(true)
    expect(options.policy.failCheckOnRequiredPendingBackfill).toBe(true)
    expect(options.limits.maxWindowHours).toBe(24 * 30)
    expect(options.limits.minChunkMinutes).toBe(15)
  })

  test('passes through configured timeColumn', () => {
    const options = normalizeBackfillOptions({
      defaults: { timeColumn: 'created_at' },
    })

    expect(options.defaults.timeColumn).toBe('created_at')
  })

  test('mergeOptions preserves base defaults when runtime only sets timeColumn', () => {
    const base = normalizeBackfillOptions()
    const merged = mergeOptions(base, { defaults: { timeColumn: 'session_date' } })

    expect(merged.defaults.chunkHours).toBe(6)
    expect(merged.defaults.maxParallelChunks).toBe(1)
    expect(merged.defaults.maxRetriesPerChunk).toBe(3)
    expect(merged.defaults.requireIdempotencyToken).toBe(true)
    expect(merged.defaults.timeColumn).toBe('session_date')
  })

  test('mergeOptions preserves base policy when runtime only sets one policy field', () => {
    const base = normalizeBackfillOptions()
    const merged = mergeOptions(base, { policy: { blockOverlappingRuns: false } })

    expect(merged.policy.requireDryRunBeforeRun).toBe(true)
    expect(merged.policy.requireExplicitWindow).toBe(true)
    expect(merged.policy.blockOverlappingRuns).toBe(false)
    expect(merged.policy.failCheckOnRequiredPendingBackfill).toBe(true)
  })

  test('mergeOptions preserves base limits when runtime only sets one limit field', () => {
    const base = normalizeBackfillOptions()
    const merged = mergeOptions(base, { limits: { maxWindowHours: 48 } })

    expect(merged.limits.maxWindowHours).toBe(48)
    expect(merged.limits.minChunkMinutes).toBe(15)
  })
})
