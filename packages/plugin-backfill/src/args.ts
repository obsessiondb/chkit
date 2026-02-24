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
  { name: '--from', type: 'string', description: 'Start timestamp', placeholder: '<timestamp>' },
  { name: '--to', type: 'string', description: 'End timestamp', placeholder: '<timestamp>' },
  { name: '--chunk-hours', type: 'string', description: 'Hours per chunk', placeholder: '<hours>' },
  { name: '--force-large-window', type: 'boolean', description: 'Allow large time windows without confirmation' },
] as const)

export const RUN_FLAGS = defineFlags([
  { name: '--plan-id', type: 'string', description: 'Plan ID to execute', placeholder: '<id>' },
  { name: '--replay-done', type: 'boolean', description: 'Re-execute already completed chunks' },
  { name: '--replay-failed', type: 'boolean', description: 'Re-execute failed chunks' },
  { name: '--force-overlap', type: 'boolean', description: 'Allow overlapping runs' },
  { name: '--force-compatibility', type: 'boolean', description: 'Skip compatibility checks' },
  { name: '--simulate-fail-chunk', type: 'string', description: 'Simulate failure on chunk', placeholder: '<chunk-id>' },
  { name: '--simulate-fail-count', type: 'string', description: 'Number of simulated failures', placeholder: '<count>' },
] as const)

export const RESUME_FLAGS = defineFlags([
  { name: '--plan-id', type: 'string', description: 'Plan ID to resume', placeholder: '<id>' },
  { name: '--replay-done', type: 'boolean', description: 'Re-execute already completed chunks' },
  { name: '--replay-failed', type: 'boolean', description: 'Re-execute failed chunks' },
  { name: '--force-overlap', type: 'boolean', description: 'Allow overlapping runs' },
  { name: '--force-compatibility', type: 'boolean', description: 'Skip compatibility checks' },
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
  const rawChunkHours = f['--chunk-hours']
  const forceLargeWindow = f['--force-large-window'] === true

  let chunkHours: number | undefined
  if (rawChunkHours !== undefined) {
    const parsed = Number(rawChunkHours)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BackfillConfigError('Invalid value for --chunk-hours. Expected a positive number.')
    }
    chunkHours = parsed
  }

  if (!target) throw new BackfillConfigError('Missing required --target <database.table>')
  if (!from) throw new BackfillConfigError('Missing required --from <timestamp>')
  if (!to) throw new BackfillConfigError('Missing required --to <timestamp>')

  return {
    target: normalizeTarget(target),
    from: normalizeTimestamp(from, '--from'),
    to: normalizeTimestamp(to, '--to'),
    chunkHours,
    forceLargeWindow,
  }
}

export function parseRunArgs(flags: ParsedFlags): ParsedRunArgs {
  const f = typedFlags(flags, RUN_FLAGS)
  const planId = f['--plan-id']
  const replayDone = f['--replay-done'] === true
  const replayFailed = f['--replay-failed'] === true
  const forceOverlap = f['--force-overlap'] === true
  const forceCompatibility = f['--force-compatibility'] === true
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
