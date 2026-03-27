import { defineFlags, typedFlags, type ParsedFlags } from '@chkit/core'

import { BackfillConfigError } from './errors.js'
import type {
  ParsedCancelArgs,
  ParsedDoctorArgs,
  ParsedPlanArgs,
  ParsedResumeArgs,
  ParsedRunArgs,
  ParsedStatusArgs,
} from './types.js'

export const PLAN_FLAGS = defineFlags([
  { name: '--target', type: 'string', description: 'Target table (database.table)', placeholder: '<database.table>' },
  { name: '--from', type: 'string', description: 'Filter partitions starting from timestamp', placeholder: '<timestamp>' },
  { name: '--to', type: 'string', description: 'Filter partitions up to timestamp', placeholder: '<timestamp>' },
  { name: '--max-chunk-bytes', type: 'string', description: 'Max bytes per chunk (e.g. 10G, 500M)', placeholder: '<bytes>' },
  { name: '--force', type: 'boolean', description: 'Delete existing plan and regenerate from scratch' },
] as const)

export const RUN_FLAGS = defineFlags([
  { name: '--plan-id', type: 'string', description: 'Plan ID to execute', placeholder: '<id>' },
  { name: '--replay-done', type: 'boolean', description: 'Re-execute already completed chunks' },
  { name: '--replay-failed', type: 'boolean', description: 'Re-execute failed chunks' },
  { name: '--force-overlap', type: 'boolean', description: 'Allow overlapping runs' },
  { name: '--force-compatibility', type: 'boolean', description: 'Skip compatibility checks' },
  { name: '--force-environment', type: 'boolean', description: 'Skip environment mismatch checks' },
  { name: '--simulate-fail-chunk', type: 'string', description: 'Simulate failure on chunk', placeholder: '<chunk-id>' },
  { name: '--simulate-fail-count', type: 'string', description: 'Number of simulated failures', placeholder: '<count>' },
] as const)

export const RESUME_FLAGS = defineFlags([
  { name: '--plan-id', type: 'string', description: 'Plan ID to resume', placeholder: '<id>' },
  { name: '--replay-done', type: 'boolean', description: 'Re-execute already completed chunks' },
  { name: '--replay-failed', type: 'boolean', description: 'Re-execute failed chunks' },
  { name: '--force-overlap', type: 'boolean', description: 'Allow overlapping runs' },
  { name: '--force-compatibility', type: 'boolean', description: 'Skip compatibility checks' },
  { name: '--force-environment', type: 'boolean', description: 'Skip environment mismatch checks' },
] as const)

export const PLAN_ID_FLAGS = defineFlags([
  { name: '--plan-id', type: 'string', description: 'Plan ID', placeholder: '<id>' },
] as const)

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
    throw new BackfillConfigError(`Invalid byte size: ${raw}. Expected a number with optional suffix (K, M, G, T).`)
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
    throw new BackfillConfigError('Invalid value for --plan-id. Expected a 16-char lowercase hex id.')
  }
  return value
}

export function parsePlanArgs(flags: ParsedFlags): ParsedPlanArgs {
  const f = typedFlags(flags, PLAN_FLAGS)
  const target = f['--target']
  const from = f['--from']
  const to = f['--to']
  const rawMaxChunkBytes = f['--max-chunk-bytes']
  const force = f['--force'] === true

  let maxChunkBytes: number | undefined
  if (rawMaxChunkBytes !== undefined) {
    maxChunkBytes = parseByteSize(rawMaxChunkBytes)
  }

  if (!target) throw new BackfillConfigError('Missing required --target <database.table>')

  return {
    target: normalizeTarget(target),
    from: from ? normalizeTimestamp(from, '--from') : undefined,
    to: to ? normalizeTimestamp(to, '--to') : undefined,
    maxChunkBytes,
    force,
  }
}

export function parseRunArgs(flags: ParsedFlags): ParsedRunArgs {
  const f = typedFlags(flags, RUN_FLAGS)
  const planId = f['--plan-id']
  const replayDone = f['--replay-done'] === true
  const replayFailed = f['--replay-failed'] === true
  const forceOverlap = f['--force-overlap'] === true
  const forceCompatibility = f['--force-compatibility'] === true
  const forceEnvironment = f['--force-environment'] === true
  const simulateFailChunk = f['--simulate-fail-chunk']

  let simulateFailCount = 1
  const rawSimulateFailCount = f['--simulate-fail-count']
  if (rawSimulateFailCount !== undefined) {
    const parsed = Number(rawSimulateFailCount)
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new BackfillConfigError('Invalid value for --simulate-fail-count. Expected integer > 0.')
    }
    simulateFailCount = parsed
  }

  if (!planId) throw new BackfillConfigError('Missing required --plan-id <id>')

  return {
    planId: normalizePlanId(planId),
    replayDone,
    replayFailed,
    forceOverlap,
    forceCompatibility,
    forceEnvironment,
    simulateFailChunk,
    simulateFailCount,
  }
}

export function parseResumeArgs(flags: ParsedFlags): ParsedResumeArgs {
  const parsed = parseRunArgs(flags)
  return {
    planId: parsed.planId,
    replayDone: parsed.replayDone,
    replayFailed: parsed.replayFailed,
    forceOverlap: parsed.forceOverlap,
    forceCompatibility: parsed.forceCompatibility,
    forceEnvironment: parsed.forceEnvironment,
  }
}

export function parseStatusArgs(flags: ParsedFlags): ParsedStatusArgs {
  const f = typedFlags(flags, PLAN_ID_FLAGS)
  const planId = f['--plan-id']
  if (!planId) throw new BackfillConfigError('Missing required --plan-id <id>')
  return { planId: normalizePlanId(planId) }
}

export function parseCancelArgs(flags: ParsedFlags): ParsedCancelArgs {
  return parseStatusArgs(flags)
}

export function parseDoctorArgs(flags: ParsedFlags): ParsedDoctorArgs {
  return parseStatusArgs(flags)
}
