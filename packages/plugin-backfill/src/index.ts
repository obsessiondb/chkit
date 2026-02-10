import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { ChxInlinePluginRegistration, ResolvedChxConfig } from '@chx/core'

export interface BackfillPluginDefaults {
  chunkHours?: number
  maxParallelChunks?: number
  maxRetriesPerChunk?: number
  requireIdempotencyToken?: boolean
}

export interface BackfillPluginPolicy {
  requireDryRunBeforeRun?: boolean
  requireExplicitWindow?: boolean
  blockOverlappingRuns?: boolean
  failCheckOnRequiredPendingBackfill?: boolean
}

export interface BackfillPluginLimits {
  maxWindowHours?: number
  minChunkMinutes?: number
}

export interface BackfillPluginOptions {
  stateDir?: string
  defaults?: BackfillPluginDefaults
  policy?: BackfillPluginPolicy
  limits?: BackfillPluginLimits
}

export interface NormalizedBackfillPluginOptions {
  stateDir?: string
  defaults: Required<BackfillPluginDefaults>
  policy: Required<BackfillPluginPolicy>
  limits: Required<BackfillPluginLimits>
}

export type BackfillPlanStatus = 'planned' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface BackfillChunk {
  id: string
  from: string
  to: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  attempts: number
  idempotencyToken: string
  sqlTemplate: string
  lastError?: string
}

export interface BackfillPlanState {
  planId: string
  target: string
  createdAt: string
  status: BackfillPlanStatus
  from: string
  to: string
  chunks: BackfillChunk[]
  options: {
    chunkHours: number
    maxParallelChunks: number
    maxRetriesPerChunk: number
    requireIdempotencyToken: boolean
  }
  policy: Required<BackfillPluginPolicy>
  limits: Required<BackfillPluginLimits>
}

export interface BuildBackfillPlanInput {
  target: string
  from: string
  to: string
  options?: NormalizedBackfillPluginOptions
}

export interface BuildBackfillPlanOutput {
  plan: BackfillPlanState
  planPath: string
  existed: boolean
}

export interface BackfillPluginCommandContext {
  args: string[]
  jsonMode: boolean
  options: Record<string, unknown>
  config: ResolvedChxConfig
  configPath: string
  print: (value: unknown) => void
}

export interface BackfillPlugin {
  manifest: {
    name: 'backfill'
    apiVersion: 1
    version?: string
  }
  commands: Array<{
    name: 'plan'
    description: string
    run: (context: BackfillPluginCommandContext) => undefined | number | Promise<undefined | number>
  }>
  hooks?: {
    onConfigLoaded?: (context: { command: string; configPath: string; options: Record<string, unknown> }) => void
  }
}

export type BackfillPluginRegistration = ChxInlinePluginRegistration<
  BackfillPlugin,
  BackfillPluginOptions
>

interface ParsedPlanArgs {
  target: string
  from: string
  to: string
  chunkHours?: number
  forceLargeWindow: boolean
}

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

class BackfillConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackfillConfigError'
  }
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
      blockOverlappingRuns: parseBoolean(options.policy.blockOverlappingRuns, 'policy.blockOverlappingRuns'),
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

function mergeOptions(
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

function hashId(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

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

function parsePlanArgs(args: string[]): ParsedPlanArgs {
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

function ensureHoursWithinLimits(input: {
  from: string
  to: string
  limits: Required<BackfillPluginLimits>
  forceLargeWindow: boolean
}): void {
  const fromMillis = new Date(input.from).getTime()
  const toMillis = new Date(input.to).getTime()
  if (toMillis <= fromMillis) {
    throw new BackfillConfigError('Invalid backfill window. Expected --to to be after --from.')
  }

  const durationHours = (toMillis - fromMillis) / (1000 * 60 * 60)
  if (durationHours > input.limits.maxWindowHours && !input.forceLargeWindow) {
    throw new BackfillConfigError(
      `Requested window (${durationHours.toFixed(2)} hours) exceeds limits.maxWindowHours=${input.limits.maxWindowHours}. Retry with --force-large-window to acknowledge risk.`
    )
  }
}

function buildChunkSqlTemplate(chunk: {
  planId: string
  chunkId: string
  token: string
  target: string
  from: string
  to: string
}): string {
  return [
    `/* chx backfill plan=${chunk.planId} chunk=${chunk.chunkId} token=${chunk.token} */`,
    `INSERT INTO ${chunk.target}`,
    `SELECT *`,
    `FROM ${chunk.target}`,
    `WHERE event_time >= toDateTime('${chunk.from}')`,
    `  AND event_time < toDateTime('${chunk.to}');`,
  ].join('\n')
}

function buildChunks(input: {
  planId: string
  target: string
  from: string
  to: string
  chunkHours: number
  requireIdempotencyToken: boolean
}): BackfillChunk[] {
  const fromMillis = new Date(input.from).getTime()
  const toMillis = new Date(input.to).getTime()
  const chunkMillis = input.chunkHours * 60 * 60 * 1000

  const chunks: BackfillChunk[] = []
  let current = fromMillis

  while (current < toMillis) {
    const next = Math.min(current + chunkMillis, toMillis)
    const chunkFrom = new Date(current).toISOString()
    const chunkTo = new Date(next).toISOString()
    const idSeed = `${input.planId}:${chunkFrom}:${chunkTo}`
    const chunkId = hashId(`chunk:${idSeed}`).slice(0, 16)
    const token = input.requireIdempotencyToken ? hashId(`token:${idSeed}`) : ''

    chunks.push({
      id: chunkId,
      from: chunkFrom,
      to: chunkTo,
      status: 'pending',
      attempts: 0,
      idempotencyToken: token,
      sqlTemplate: buildChunkSqlTemplate({
        planId: input.planId,
        chunkId,
        token,
        target: input.target,
        from: chunkFrom,
        to: chunkTo,
      }),
    })

    current = next
  }

  return chunks
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(',')}}`
}

function planIdentity(target: string, from: string, to: string, chunkHours: number): string {
  return `${target}|${from}|${to}|${chunkHours}`
}

export function computeBackfillStateDir(
  config: Pick<ResolvedChxConfig, 'metaDir'>,
  configPath: string,
  options: NormalizedBackfillPluginOptions
): string {
  if (options.stateDir && options.stateDir.length > 0) {
    return resolve(dirname(configPath), options.stateDir)
  }
  return resolve(dirname(configPath), config.metaDir, 'backfill')
}

async function readExistingPlan(planPath: string): Promise<BackfillPlanState | null> {
  if (!existsSync(planPath)) return null
  const raw = await readFile(planPath, 'utf8')
  return JSON.parse(raw) as BackfillPlanState
}

export async function buildBackfillPlan(input: {
  target: string
  from: string
  to: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
  chunkHours?: number
  forceLargeWindow?: boolean
}): Promise<BuildBackfillPlanOutput> {
  const chunkHours = input.chunkHours ?? input.options.defaults.chunkHours
  if (chunkHours * 60 < input.options.limits.minChunkMinutes) {
    throw new BackfillConfigError(
      `Chunk size ${chunkHours}h is below limits.minChunkMinutes=${input.options.limits.minChunkMinutes}.`
    )
  }

  ensureHoursWithinLimits({
    from: input.from,
    to: input.to,
    limits: input.options.limits,
    forceLargeWindow: input.forceLargeWindow ?? false,
  })

  const planId = hashId(planIdentity(input.target, input.from, input.to, chunkHours)).slice(0, 16)
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.options)
  const planPath = join(stateDir, 'plans', `${planId}.json`)

  const plan: BackfillPlanState = {
    planId,
    target: input.target,
    createdAt: '1970-01-01T00:00:00.000Z',
    status: 'planned',
    from: input.from,
    to: input.to,
    chunks: buildChunks({
      planId,
      target: input.target,
      from: input.from,
      to: input.to,
      chunkHours,
      requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
    }),
    options: {
      chunkHours,
      maxParallelChunks: input.options.defaults.maxParallelChunks,
      maxRetriesPerChunk: input.options.defaults.maxRetriesPerChunk,
      requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
    },
    policy: input.options.policy,
    limits: input.options.limits,
  }

  const existing = await readExistingPlan(planPath)
  if (existing) {
    if (stableSerialize(existing) !== stableSerialize(plan)) {
      throw new BackfillConfigError(
        `Backfill plan already exists at ${planPath} but differs from current planning output. Remove it if you intentionally changed planning parameters.`
      )
    }
    return {
      plan: existing,
      planPath,
      existed: true,
    }
  }

  await mkdir(dirname(planPath), { recursive: true })
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

  return {
    plan,
    planPath,
    existed: false,
  }
}

function validateBaseOptions(options: NormalizedBackfillPluginOptions): void {
  if (options.defaults.chunkHours * 60 < options.limits.minChunkMinutes) {
    throw new BackfillConfigError(
      `defaults.chunkHours (${options.defaults.chunkHours}) must be >= limits.minChunkMinutes (${options.limits.minChunkMinutes}m).`
    )
  }
}

function planPayload(output: BuildBackfillPlanOutput): {
  ok: true
  command: 'plan'
  planId: string
  target: string
  from: string
  to: string
  chunkCount: number
  chunkHours: number
  planPath: string
  existed: boolean
} {
  return {
    ok: true,
    command: 'plan',
    planId: output.plan.planId,
    target: output.plan.target,
    from: output.plan.from,
    to: output.plan.to,
    chunkCount: output.plan.chunks.length,
    chunkHours: output.plan.options.chunkHours,
    planPath: output.planPath,
    existed: output.existed,
  }
}

export function createBackfillPlugin(options: BackfillPluginOptions = {}): BackfillPlugin {
  const base = normalizeBackfillOptions(options)
  validateBaseOptions(base)

  return {
    manifest: {
      name: 'backfill',
      apiVersion: 1,
    },
    commands: [
      {
        name: 'plan',
        description: 'Build a deterministic backfill plan and persist immutable plan state',
        async run({ args, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parsePlanArgs(args)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)
            if (effectiveOptions.policy.requireExplicitWindow && (!parsed.from || !parsed.to)) {
              throw new BackfillConfigError('Backfill planning requires explicit --from and --to.')
            }

            const output = await buildBackfillPlan({
              target: parsed.target,
              from: parsed.from,
              to: parsed.to,
              config,
              configPath,
              options: effectiveOptions,
              chunkHours: parsed.chunkHours,
              forceLargeWindow: parsed.forceLargeWindow,
            })

            const payload = planPayload(output)
            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill plan ${payload.planId} for ${payload.target} (${payload.chunkCount} chunks at ${payload.chunkHours}h) -> ${payload.planPath}${payload.existed ? ' [existing]' : ''}`
              )
            }

            return 0
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({
                ok: false,
                command: 'plan',
                error: message,
              })
            } else {
              print(`Backfill plan failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) {
              return 2
            }
            return 1
          }
        },
      },
    ],
    hooks: {
      onConfigLoaded({ options: runtimeOptions }) {
        const merged = mergeOptions(base, runtimeOptions)
        validateBaseOptions(merged)
      },
    },
  }
}

export function backfill(options: BackfillPluginOptions = {}): BackfillPluginRegistration {
  return {
    plugin: createBackfillPlugin(),
    name: 'backfill',
    enabled: true,
    options,
  }
}

export const backfillPlan = buildBackfillPlan
