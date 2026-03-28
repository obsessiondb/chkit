import { z } from 'zod'
import { defineFlags, resolveOptions, type FlagMapping } from '@chkit/core'

import { BackfillConfigError } from './errors.js'

const GiB = 1024 ** 3

// ───── Coercion helpers ─────

function normalizeTimestamp(raw: string, flagName: string): string {
  const value = raw.trim()
  if (value.length === 0) {
    throw new BackfillConfigError(`Missing value for ${flagName}`)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new BackfillConfigError(`Invalid timestamp for ${flagName}: ${raw}`)
  }
  return date.toISOString()
}

function normalizeTarget(raw: string): string {
  const value = raw.trim()
  if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(value)) {
    throw new BackfillConfigError('Invalid value for --target. Expected <database.table>.')
  }
  return value
}

const BYTE_SUFFIXES: Record<string, number> = {
  T: 1024 ** 4,
  G: 1024 ** 3,
  M: 1024 ** 2,
  K: 1024,
}

export function parseByteSize(raw: string): number {
  const trimmed = raw.trim().toUpperCase()
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([TGMK])?$/)
  if (!match) {
    throw new BackfillConfigError(
      `Invalid byte size: ${raw}. Expected a number with optional suffix (K, M, G, T).`
    )
  }
  const value = Number(match[1])
  const suffix = match[2]
  const multiplier = suffix ? BYTE_SUFFIXES[suffix] ?? 1 : 1
  const result = value * multiplier
  if (!Number.isFinite(result) || result <= 0) {
    throw new BackfillConfigError(`Invalid byte size: ${raw}. Must be a positive number.`)
  }
  return result
}

function normalizePlanId(raw: string): string {
  const value = raw.trim()
  if (!/^[a-f0-9]{16}$/.test(value)) {
    throw new BackfillConfigError(
      'Invalid value for --plan-id. Expected a 16-char lowercase hex id.'
    )
  }
  return value
}

// ───── Plugin config schema (what backfill({...}) accepts) ─────

export const PluginConfigSchema = z.object({
  maxChunkBytes: z.number().positive().optional(),
  maxRetriesPerChunk: z.number().int().positive().optional(),
  retryDelayMs: z.number().nonnegative().optional(),
  maxParallelChunks: z.number().int().positive().optional(),
  requireIdempotencyToken: z.boolean().optional(),
  chunkHours: z.number().positive().optional(),
  timeColumn: z.string().min(1).optional(),
  requireDryRunBeforeRun: z.boolean().optional(),
  requireExplicitWindow: z.boolean().optional(),
  blockOverlappingRuns: z.boolean().optional(),
  failCheckOnRequiredPendingBackfill: z.boolean().optional(),
  maxWindowHours: z.number().positive().optional(),
  minChunkMinutes: z.number().positive().optional(),
  stateDir: z.string().min(1).optional(),
})

export type PluginConfig = z.input<typeof PluginConfigSchema>

// ───── Per-command schemas ─────

export const PlanSchema = z.object({
  target: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  maxChunkBytes: z.number().positive().default(10 * GiB),
  maxParallelChunks: z.number().int().positive().default(1),
  maxRetriesPerChunk: z.number().int().positive().default(3),
  requireIdempotencyToken: z.boolean().default(true),
  requireExplicitWindow: z.boolean().default(true),
  blockOverlappingRuns: z.boolean().default(true),
  requireDryRunBeforeRun: z.boolean().default(true),
  failCheckOnRequiredPendingBackfill: z.boolean().default(true),
  maxWindowHours: z.number().positive().default(720),
  minChunkMinutes: z.number().positive().default(15),
  chunkHours: z.number().positive().optional(),
  timeColumn: z.string().min(1).optional(),
  stateDir: z.string().min(1).optional(),
})
export type PlanOptions = z.infer<typeof PlanSchema>

export const RunSchema = z.object({
  planId: z.string(),
  forceEnvironment: z.boolean().default(false),
  concurrency: z.number().int().positive().default(3),
  pollIntervalMs: z.number().nonnegative().default(5000),
  stateDir: z.string().min(1).optional(),
})
export type RunOptions = z.infer<typeof RunSchema>

export const ResumeSchema = RunSchema.extend({
  replayFailed: z.boolean().default(false),
})
export type ResumeOptions = z.infer<typeof ResumeSchema>

export const StatusSchema = z.object({
  planId: z.string(),
  stateDir: z.string().min(1).optional(),
})
export type StatusOptions = z.infer<typeof StatusSchema>

export const CancelSchema = StatusSchema
export type CancelOptions = StatusOptions

export const DoctorSchema = StatusSchema
export type DoctorOptions = StatusOptions

export const CheckSchema = z.object({
  stateDir: z.string().min(1).optional(),
  failCheckOnRequiredPendingBackfill: z.boolean().default(true),
})
export type CheckOptions = z.infer<typeof CheckSchema>

// ───── CLI flag definitions ─────

export const PLAN_FLAGS = defineFlags([
  { name: '--target', type: 'string', description: 'Target table (database.table)', placeholder: '<database.table>' },
  { name: '--from', type: 'string', description: 'Filter partitions starting from timestamp', placeholder: '<timestamp>' },
  { name: '--to', type: 'string', description: 'Filter partitions up to timestamp', placeholder: '<timestamp>' },
  { name: '--max-chunk-bytes', type: 'string', description: 'Max bytes per chunk (e.g. 10G, 500M)', placeholder: '<bytes>' },
] as const)

export const RUN_FLAGS = defineFlags([
  { name: '--plan-id', type: 'string', description: 'Plan ID to execute', placeholder: '<id>' },
  { name: '--force-environment', type: 'boolean', description: 'Skip environment mismatch checks' },
  { name: '--concurrency', type: 'string', description: 'Max concurrent async queries', placeholder: '<n>' },
  { name: '--poll-interval', type: 'string', description: 'Polling interval in ms', placeholder: '<ms>' },
] as const)

export const RESUME_FLAGS = defineFlags([
  { name: '--plan-id', type: 'string', description: 'Plan ID to resume', placeholder: '<id>' },
  { name: '--force-environment', type: 'boolean', description: 'Skip environment mismatch checks' },
  { name: '--concurrency', type: 'string', description: 'Max concurrent async queries', placeholder: '<n>' },
  { name: '--poll-interval', type: 'string', description: 'Polling interval in ms', placeholder: '<ms>' },
  { name: '--replay-failed', type: 'boolean', description: 'Re-execute failed chunks' },
] as const)

export const PLAN_ID_FLAGS = defineFlags([
  { name: '--plan-id', type: 'string', description: 'Plan ID', placeholder: '<id>' },
] as const)

// ───── Flag mappings ─────

const PLAN_FLAG_MAP: FlagMapping = {
  '--target': { key: 'target', coerce: normalizeTarget },
  '--from': { key: 'from', coerce: (v) => normalizeTimestamp(v, '--from') },
  '--to': { key: 'to', coerce: (v) => normalizeTimestamp(v, '--to') },
  '--max-chunk-bytes': { key: 'maxChunkBytes', coerce: parseByteSize },
}

function coercePositiveInt(v: string, flag: string): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new BackfillConfigError(`Invalid value for ${flag}. Expected integer > 0.`)
  }
  return n
}

const RUN_FLAG_MAP: FlagMapping = {
  '--plan-id': { key: 'planId', coerce: normalizePlanId },
  '--force-environment': { key: 'forceEnvironment' },
  '--concurrency': { key: 'concurrency', coerce: (v) => coercePositiveInt(v, '--concurrency') },
  '--poll-interval': { key: 'pollIntervalMs', coerce: (v) => coercePositiveInt(v, '--poll-interval') },
}

const RESUME_FLAG_MAP: FlagMapping = {
  '--plan-id': { key: 'planId', coerce: normalizePlanId },
  '--force-environment': { key: 'forceEnvironment' },
  '--concurrency': { key: 'concurrency', coerce: (v) => coercePositiveInt(v, '--concurrency') },
  '--poll-interval': { key: 'pollIntervalMs', coerce: (v) => coercePositiveInt(v, '--poll-interval') },
  '--replay-failed': { key: 'replayFailed' },
}

const PLAN_ID_FLAG_MAP: FlagMapping = {
  '--plan-id': { key: 'planId', coerce: normalizePlanId },
}

// ───── Per-command resolvers ─────

export function resolvePlanOptions(
  pluginConfig: Record<string, unknown>,
  runtimeOptions: Record<string, unknown>,
  flags: Record<string, string | string[] | boolean | undefined>
): PlanOptions {
  return resolveOptions(PlanSchema, pluginConfig, runtimeOptions, flags, PLAN_FLAG_MAP, BackfillConfigError)
}

export function resolveRunOptions(
  pluginConfig: Record<string, unknown>,
  runtimeOptions: Record<string, unknown>,
  flags: Record<string, string | string[] | boolean | undefined>
): RunOptions {
  return resolveOptions(RunSchema, pluginConfig, runtimeOptions, flags, RUN_FLAG_MAP, BackfillConfigError)
}

export function resolveResumeOptions(
  pluginConfig: Record<string, unknown>,
  runtimeOptions: Record<string, unknown>,
  flags: Record<string, string | string[] | boolean | undefined>
): ResumeOptions {
  return resolveOptions(ResumeSchema, pluginConfig, runtimeOptions, flags, RESUME_FLAG_MAP, BackfillConfigError)
}

export function resolveStatusOptions(
  pluginConfig: Record<string, unknown>,
  runtimeOptions: Record<string, unknown>,
  flags: Record<string, string | string[] | boolean | undefined>
): StatusOptions {
  return resolveOptions(StatusSchema, pluginConfig, runtimeOptions, flags, PLAN_ID_FLAG_MAP, BackfillConfigError)
}

export function resolveCheckOptions(
  pluginConfig: Record<string, unknown>,
  runtimeOptions: Record<string, unknown>
): CheckOptions {
  return resolveOptions(CheckSchema, pluginConfig, runtimeOptions, {}, {}, BackfillConfigError)
}
