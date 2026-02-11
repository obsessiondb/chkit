import { BackfillConfigError } from './errors.js'
import type { BackfillPluginOptions, NormalizedBackfillPluginOptions } from './types.js'

const DEFAULT_OPTIONS: NormalizedBackfillPluginOptions = {
  defaults: {
    chunkHours: 6,
    maxParallelChunks: 1,
    maxRetriesPerChunk: 3,
    requireIdempotencyToken: true,
  },
  policy: {
    requireDryRunBeforeRun: true,
    requireExplicitWindow: true,
    blockOverlappingRuns: true,
    failCheckOnRequiredPendingBackfill: true,
  },
  limits: {
    maxWindowHours: 24 * 30,
    minChunkMinutes: 15,
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePositiveNumber(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BackfillConfigError(`Invalid plugin option "${key}". Expected a positive number.`)
  }
  return value
}

function parseBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new BackfillConfigError(`Invalid plugin option "${key}". Expected boolean.`)
  }
  return value
}

function parseString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BackfillConfigError(`Invalid plugin option "${key}". Expected non-empty string.`)
  }
  return value
}

function normalizeRuntimeOptions(options: Record<string, unknown>): BackfillPluginOptions {
  const normalized: BackfillPluginOptions = {}

  const stateDir = parseString(options.stateDir, 'stateDir')
  if (stateDir !== undefined) normalized.stateDir = stateDir

  if (options.defaults !== undefined) {
    if (!isRecord(options.defaults)) {
      throw new BackfillConfigError('Invalid plugin option "defaults". Expected object.')
    }
    normalized.defaults = {
      chunkHours: parsePositiveNumber(options.defaults.chunkHours, 'defaults.chunkHours'),
      maxParallelChunks: parsePositiveNumber(
        options.defaults.maxParallelChunks,
        'defaults.maxParallelChunks'
      ),
      maxRetriesPerChunk: parsePositiveNumber(
        options.defaults.maxRetriesPerChunk,
        'defaults.maxRetriesPerChunk'
      ),
      requireIdempotencyToken: parseBoolean(
        options.defaults.requireIdempotencyToken,
        'defaults.requireIdempotencyToken'
      ),
    }
  }

  if (options.policy !== undefined) {
    if (!isRecord(options.policy)) {
      throw new BackfillConfigError('Invalid plugin option "policy". Expected object.')
    }
    normalized.policy = {
      requireDryRunBeforeRun: parseBoolean(
        options.policy.requireDryRunBeforeRun,
        'policy.requireDryRunBeforeRun'
      ),
      requireExplicitWindow: parseBoolean(
        options.policy.requireExplicitWindow,
        'policy.requireExplicitWindow'
      ),
      blockOverlappingRuns: parseBoolean(
        options.policy.blockOverlappingRuns,
        'policy.blockOverlappingRuns'
      ),
      failCheckOnRequiredPendingBackfill: parseBoolean(
        options.policy.failCheckOnRequiredPendingBackfill,
        'policy.failCheckOnRequiredPendingBackfill'
      ),
    }
  }

  if (options.limits !== undefined) {
    if (!isRecord(options.limits)) {
      throw new BackfillConfigError('Invalid plugin option "limits". Expected object.')
    }
    normalized.limits = {
      maxWindowHours: parsePositiveNumber(options.limits.maxWindowHours, 'limits.maxWindowHours'),
      minChunkMinutes: parsePositiveNumber(options.limits.minChunkMinutes, 'limits.minChunkMinutes'),
    }
  }

  return normalized
}

export function normalizeBackfillOptions(
  options: BackfillPluginOptions = {}
): NormalizedBackfillPluginOptions {
  return {
    stateDir: options.stateDir,
    defaults: {
      ...DEFAULT_OPTIONS.defaults,
      ...(options.defaults ?? {}),
    },
    policy: {
      ...DEFAULT_OPTIONS.policy,
      ...(options.policy ?? {}),
    },
    limits: {
      ...DEFAULT_OPTIONS.limits,
      ...(options.limits ?? {}),
    },
  }
}

export function mergeOptions(
  baseOptions: NormalizedBackfillPluginOptions,
  runtimeOptions: Record<string, unknown>
): NormalizedBackfillPluginOptions {
  const fromRuntime = normalizeRuntimeOptions(runtimeOptions)
  return normalizeBackfillOptions({
    stateDir: fromRuntime.stateDir ?? baseOptions.stateDir,
    defaults: {
      ...baseOptions.defaults,
      ...(fromRuntime.defaults ?? {}),
    },
    policy: {
      ...baseOptions.policy,
      ...(fromRuntime.policy ?? {}),
    },
    limits: {
      ...baseOptions.limits,
      ...(fromRuntime.limits ?? {}),
    },
  })
}

export function validateBaseOptions(options: NormalizedBackfillPluginOptions): void {
  if (options.defaults.chunkHours * 60 < options.limits.minChunkMinutes) {
    throw new BackfillConfigError(
      `defaults.chunkHours (${options.defaults.chunkHours}) must be >= limits.minChunkMinutes (${options.limits.minChunkMinutes}m).`
    )
  }
}
