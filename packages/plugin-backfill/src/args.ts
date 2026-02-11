import { BackfillConfigError } from './errors.js'
import type {
  ParsedCancelArgs,
  ParsedDoctorArgs,
  ParsedPlanArgs,
  ParsedResumeArgs,
  ParsedRunArgs,
  ParsedStatusArgs,
} from './types.js'

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

export function parsePlanArgs(args: string[]): ParsedPlanArgs {
  let target: string | undefined
  let from: string | undefined
  let to: string | undefined
  let chunkHours: number | undefined
  let forceLargeWindow = false

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (!token) continue

    if (token === '--force-large-window') {
      forceLargeWindow = true
      continue
    }

    if (token === '--target' || token === '--from' || token === '--to' || token === '--chunk-hours') {
      const nextValue = args[i + 1]
      if (!nextValue || nextValue.startsWith('--')) {
        throw new BackfillConfigError(`Missing value for ${token}`)
      }

      if (token === '--target') target = nextValue
      if (token === '--from') from = nextValue
      if (token === '--to') to = nextValue
      if (token === '--chunk-hours') {
        const parsed = Number(nextValue)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new BackfillConfigError('Invalid value for --chunk-hours. Expected a positive number.')
        }
        chunkHours = parsed
      }

      i += 1
    }
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

export function parseRunArgs(args: string[]): ParsedRunArgs {
  let planId: string | undefined
  let replayDone = false
  let replayFailed = false
  let forceOverlap = false
  let forceCompatibility = false
  let simulateFailChunk: string | undefined
  let simulateFailCount = 1

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (!token) continue

    if (token === '--replay-done') {
      replayDone = true
      continue
    }

    if (token === '--replay-failed') {
      replayFailed = true
      continue
    }

    if (token === '--force-overlap') {
      forceOverlap = true
      continue
    }

    if (token === '--force-compatibility') {
      forceCompatibility = true
      continue
    }

    if (
      token === '--plan-id' ||
      token === '--simulate-fail-chunk' ||
      token === '--simulate-fail-count'
    ) {
      const nextValue = args[i + 1]
      if (!nextValue || nextValue.startsWith('--')) {
        throw new BackfillConfigError(`Missing value for ${token}`)
      }

      if (token === '--plan-id') planId = nextValue
      if (token === '--simulate-fail-chunk') simulateFailChunk = nextValue
      if (token === '--simulate-fail-count') {
        const parsed = Number(nextValue)
        if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
          throw new BackfillConfigError('Invalid value for --simulate-fail-count. Expected integer > 0.')
        }
        simulateFailCount = parsed
      }

      i += 1
    }
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

export function parseResumeArgs(args: string[]): ParsedResumeArgs {
  const parsed = parseRunArgs(args)
  return {
    planId: parsed.planId,
    replayDone: parsed.replayDone,
    replayFailed: parsed.replayFailed,
    forceOverlap: parsed.forceOverlap,
    forceCompatibility: parsed.forceCompatibility,
  }
}

export function parseStatusArgs(args: string[]): ParsedStatusArgs {
  let planId: string | undefined

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token !== '--plan-id') continue

    const nextValue = args[i + 1]
    if (!nextValue || nextValue.startsWith('--')) {
      throw new BackfillConfigError('Missing value for --plan-id')
    }
    planId = nextValue
    i += 1
  }

  if (!planId) throw new BackfillConfigError('Missing required --plan-id <id>')

  return { planId: normalizePlanId(planId) }
}

export function parseCancelArgs(args: string[]): ParsedCancelArgs {
  return parseStatusArgs(args)
}

export function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  return parseStatusArgs(args)
}
