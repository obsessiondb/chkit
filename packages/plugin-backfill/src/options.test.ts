import { describe, expect, test } from 'bun:test'

import { normalizeBackfillOptions } from './options.js'

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
})
