import { BackfillConfigError } from './errors.js'
import type {
  ParsedCancelArgs,
  ParsedDoctorArgs,
  ParsedPlanArgs,
  ParsedResumeArgs,
  ParsedRunArgs,
  ParsedStatusArgs,
} from './types.js'

type ParsedFlags = Record<string, string | string[] | boolean | undefined>

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
  const target = flags['--target'] as string | undefined
  const from = flags['--from'] as string | undefined
  const to = flags['--to'] as string | undefined
  const rawChunkHours = flags['--chunk-hours'] as string | undefined
  const forceLargeWindow = flags['--force-large-window'] === true

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
  const planId = flags['--plan-id'] as string | undefined
  const replayDone = flags['--replay-done'] === true
  const replayFailed = flags['--replay-failed'] === true
  const forceOverlap = flags['--force-overlap'] === true
  const forceCompatibility = flags['--force-compatibility'] === true
  const simulateFailChunk = flags['--simulate-fail-chunk'] as string | undefined

  let simulateFailCount = 1
  const rawSimulateFailCount = flags['--simulate-fail-count'] as string | undefined
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
  const planId = flags['--plan-id'] as string | undefined
  if (!planId) throw new BackfillConfigError('Missing required --plan-id <id>')
  return { planId: normalizePlanId(planId) }
}

export function parseCancelArgs(flags: ParsedFlags): ParsedCancelArgs {
  return parseStatusArgs(flags)
}

export function parseDoctorArgs(flags: ParsedFlags): ParsedDoctorArgs {
  return parseStatusArgs(flags)
}
