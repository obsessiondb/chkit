import { describe, expect, test } from 'bun:test'
import { resolveOptions } from '@chkit/core'

import {
  parseByteSize,
  PlanSchema,
  RunSchema,
  ResumeSchema,
  CheckSchema,
  PluginConfigSchema,
} from './options.js'

describe('parseByteSize', () => {
  test('parses gigabytes', () => {
    expect(parseByteSize('10G')).toBe(10 * 1024 ** 3)
  })

  test('parses megabytes', () => {
    expect(parseByteSize('500M')).toBe(500 * 1024 ** 2)
  })

  test('parses terabytes', () => {
    expect(parseByteSize('1T')).toBe(1024 ** 4)
  })

  test('parses kilobytes', () => {
    expect(parseByteSize('256K')).toBe(256 * 1024)
  })

  test('parses plain number as bytes', () => {
    expect(parseByteSize('1048576')).toBe(1048576)
  })

  test('parses decimal values', () => {
    expect(parseByteSize('1.5G')).toBe(1.5 * 1024 ** 3)
  })

  test('is case-insensitive', () => {
    expect(parseByteSize('10g')).toBe(10 * 1024 ** 3)
    expect(parseByteSize('500m')).toBe(500 * 1024 ** 2)
  })

  test('trims whitespace', () => {
    expect(parseByteSize('  10G  ')).toBe(10 * 1024 ** 3)
  })

  test('throws on invalid input', () => {
    expect(() => parseByteSize('abc')).toThrow('Invalid byte size')
    expect(() => parseByteSize('')).toThrow('Invalid byte size')
    expect(() => parseByteSize('10X')).toThrow('Invalid byte size')
  })
})

describe('PlanSchema defaults', () => {
  test('applies documented defaults', () => {
    const opts = PlanSchema.parse({ target: 'default.events' })

    expect(opts.maxChunkBytes).toBe(10 * 1024 ** 3)
    expect(opts.maxParallelChunks).toBe(1)
    expect(opts.maxRetriesPerChunk).toBe(3)
    expect(opts.requireIdempotencyToken).toBe(true)
    expect(opts.requireExplicitWindow).toBe(true)
    expect(opts.blockOverlappingRuns).toBe(true)
    expect(opts.requireDryRunBeforeRun).toBe(true)
    expect(opts.failCheckOnRequiredPendingBackfill).toBe(true)
    expect(opts.maxWindowHours).toBe(720)
    expect(opts.minChunkMinutes).toBe(15)
    expect(opts.timeColumn).toBeUndefined()
  })

  test('overrides work', () => {
    const opts = PlanSchema.parse({
      target: 'default.events',
      maxChunkBytes: 5 * 1024 ** 3,
      requireIdempotencyToken: false,
    })

    expect(opts.maxChunkBytes).toBe(5 * 1024 ** 3)
    expect(opts.requireIdempotencyToken).toBe(false)
  })
})

describe('RunSchema defaults', () => {
  test('applies documented defaults', () => {
    const opts = RunSchema.parse({ planId: 'abc123def456789a' })

    expect(opts.forceEnvironment).toBe(false)
    expect(opts.concurrency).toBe(3)
    expect(opts.pollIntervalMs).toBe(5000)
  })
})

describe('ResumeSchema', () => {
  test('extends RunSchema with replayFailed', () => {
    const opts = ResumeSchema.parse({ planId: 'abc123def456789a' })

    expect(opts.forceEnvironment).toBe(false)
    expect(opts.concurrency).toBe(3)
    expect(opts.pollIntervalMs).toBe(5000)
    expect(opts.replayFailed).toBe(false)
  })
})

describe('resolveOptions', () => {
  test('CLI flags override plugin config and runtime options', () => {
    const opts = resolveOptions(
      PlanSchema,
      { maxChunkBytes: 5 * 1024 ** 3 },
      { maxChunkBytes: 8 * 1024 ** 3 },
      { '--target': 'app.events', '--max-chunk-bytes': '20G' },
      {
        '--target': { key: 'target', coerce: (v: string) => v },
        '--max-chunk-bytes': {
          key: 'maxChunkBytes',
          coerce: (v: string) => parseByteSize(v),
        },
      }
    )

    expect(opts.target).toBe('app.events')
    expect(opts.maxChunkBytes).toBe(20 * 1024 ** 3)
  })

  test('runtime options override plugin config', () => {
    const opts = resolveOptions(
      RunSchema,
      { concurrency: 2 },
      { concurrency: 5 },
      { '--plan-id': 'abc123def456789a' },
      { '--plan-id': { key: 'planId', coerce: (v: string) => v } }
    )

    expect(opts.concurrency).toBe(5)
  })

  test('schema defaults apply when no override provided', () => {
    const opts = resolveOptions(
      RunSchema,
      {},
      {},
      { '--plan-id': 'abc123def456789a' },
      { '--plan-id': { key: 'planId', coerce: (v: string) => v } }
    )

    expect(opts.concurrency).toBe(3)
    expect(opts.pollIntervalMs).toBe(5000)
    expect(opts.forceEnvironment).toBe(false)
  })

  test('throws on invalid options', () => {
    expect(() =>
      resolveOptions(PlanSchema, {}, {}, {}, {})
    ).toThrow()
  })
})

describe('PluginConfigSchema', () => {
  test('accepts empty config', () => {
    const config = PluginConfigSchema.parse({})
    expect(config).toEqual({})
  })

  test('accepts flat config fields', () => {
    const config = PluginConfigSchema.parse({
      maxRetriesPerChunk: 5,
      blockOverlappingRuns: false,
      maxWindowHours: 48,
    })

    expect(config.maxRetriesPerChunk).toBe(5)
    expect(config.blockOverlappingRuns).toBe(false)
    expect(config.maxWindowHours).toBe(48)
  })
})

describe('CheckSchema', () => {
  test('defaults failCheckOnRequiredPendingBackfill to true', () => {
    const opts = CheckSchema.parse({})
    expect(opts.failCheckOnRequiredPendingBackfill).toBe(true)
  })
})
